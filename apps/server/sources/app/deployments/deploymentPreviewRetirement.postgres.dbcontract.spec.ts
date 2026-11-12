import { AsyncLocalStorage } from 'node:async_hooks';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import * as privacyKit from 'privacy-kit';
import { ARTIFACT_PLAIN_DATA_KEY_MARKER, encodePlainArtifactStoredContent, encodePlainMachineStoredContent,
    MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { DeploymentEnvironmentContentV1Schema } from '@happier-dev/deployment-protocol';
import { AutomationDefinitionCreateRequestSchema } from '@happier-dev/protocol/automations/automationApiV3';
import { db, initDbPostgres } from '@/storage/db';
import { inTx, type Tx } from '@/storage/inTx';
import { initEncrypt } from '@/modules/encrypt';
import { createArtifact } from '@/app/artifacts/artifactWriteService';
import { observeLazyPrismaQuery } from '@/app/changes/accountPublicationContention.testkit';
import { createAutomation, updateAutomation } from '@/app/automations/automationCrudService';
import { createAutomationWorkflowRecipeFixture } from '@/testkit/automationWorkflowRecipe';
import { createProjectSourceInTx, updateProjectSourceInTx } from '@/app/projects/sources/projectSourceService';
import { createDeploymentEnvironmentInTx } from './deploymentEnvironmentService';

const serverId = `srv_${'d'.repeat(32)}`;

function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    return { promise, resolve };
}

beforeAll(async () => {
    if (!process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL
        || process.env.DATABASE_URL !== process.env.HAPPIER_TEST_POSTGRES_DATABASE_URL) {
        throw new Error('Run with the disposable PostgreSQL DB-contract harness');
    }
    process.env.HAPPIER_SERVER_IDENTITY_ID = serverId;
    process.env.HAPPIER_FEATURE_WORKFLOWS__ENABLED = '1';
    process.env.HANDY_MASTER_SECRET ??= 'preview-retirement-disposable-contract';
    await initDbPostgres();
    await db.$connect();
    await initEncrypt();
});
afterAll(async () => { await db.$disconnect(); });

it.each(['create', 're-enable'] as const)('serializes preview-role %s with Source retirement or re-admits the current Source', async action => {
    const owner = await db.account.create({ data: { encryptionMode: 'plain' } });
    const repository = { provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.example' },
        repository: { nameWithOwner: 'owner/app', cloneUrl: 'https://github.example/owner/app.git' }, protocol: 'https' as const };
    const source = await inTx(tx => createProjectSourceInTx(tx, owner.id, { serverId,
        requestKey: crypto.randomUUID(), name: 'Preview repository', audience: [], repository }));
    if (!source.ok) throw new Error(source.error);
    // Machine content matches the Account mode, as Machine admission requires (92c476ae054).
    const machine = await db.machine.create({ data: { id: crypto.randomUUID(), accountId: owner.id,
        installationId: crypto.randomUUID(), metadata: encodePlainMachineStoredContent({ host: 'Preview', platform: 'linux',
            happyCliVersion: 'test', homeDir: '/home/test', happyHomeDir: '/home/test/.happier' }),
        dataEncryptionKey: privacyKit.decodeBase64(MACHINE_PLAIN_DATA_KEY_MARKER) } });
    const composeDocument = '{"services":{"app":{"image":"app:1"}}}';
    const artifact = await createArtifact({ actorUserId: owner.id, artifactId: crypto.randomUUID(),
        header: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ kind: 'deployment-environment.v1', title: 'Preview' })),
        // Environment create opens plain content through its canonical schema (717576ac290).
        body: privacyKit.decodeBase64(encodePlainArtifactStoredContent({ body: JSON.stringify(DeploymentEnvironmentContentV1Schema.parse({
            name: 'Preview', retainPreviousDeployments: 1, bindings: [], definition: { kind: 'stored', contentRevision: 1,
                document: composeDocument, profiles: [], services: ['app'],
                composeDigest: `sha256:${createHash('sha256').update(composeDocument).digest('hex')}` } })) })),
        dataEncryptionKey: privacyKit.decodeBase64(ARTIFACT_PLAIN_DATA_KEY_MARKER) });
    if (!artifact.ok) throw new Error(artifact.error);
    const parent = await inTx(tx => createDeploymentEnvironmentInTx(tx, owner.id, {
        serverId, projectSourceId: source.source.id, protection: 'nonProduction', deployerMode: 'managers',
        controllerMachineId: machine.id, purpose: 'standard', requestKey: crypto.randomUUID(),
        contentArtifactId: artifact.artifact.id, contentHeaderVersion: 1, contentBodyVersion: 1,
    }));
    if (!parent.ok) throw new Error(parent.error);
    const admissionId = crypto.randomUUID();
    const recipe = createAutomationWorkflowRecipeFixture({ templateVersion: 1, directory: '/workspace/app', prompt: 'Private saved workflow' });
    const roleInput = AutomationDefinitionCreateRequestSchema.parse({ automationId: admissionId,
        name: 'First preview admission', enabled: true, triggers: [], assignments: [{ machineId: machine.id }],
        executionRecipe: { ...recipe, deploymentEnvironment: { serverId, projectSourceId: source.source.id,
            environmentId: parent.environmentId, previewRole: 'preview_admission' } },
    });
    if (action === 're-enable') await createAutomation({ accountId: owner.id, input: { ...roleInput, enabled: false } });
    const operation = new AsyncLocalStorage<'source' | 'role'>();
    const captured = deferred(), releaseSource = deferred();
    const sourceFinished = deferred(), sourceEnvironmentLockStarted = deferred();
    let heldCensus = false;
    const roleSourceRevisions: number[] = [];
    const transaction = db.$transaction;
    // Schedule actual SQL statements only. Both owners, their admission,
    // publication, database isolation and retry behavior remain real.
    db.$transaction = new Proxy(transaction, { apply(target, receiver, args: unknown[]) {
        const callback = args[0];
        const scope = operation.getStore();
        if (typeof callback !== 'function' || !scope) return Reflect.apply(target, receiver, args);
        return Reflect.apply(target, receiver, [async (tx: Tx) => callback(new Proxy(tx, {
            get(inner, property, innerReceiver) {
                const observedModel = scope === 'source' ? 'deploymentEnvironment' : 'projectSource';
                const observedMethod = scope === 'source' ? 'findMany' : 'findUnique';
                if (scope === 'source' && property === '$queryRawUnsafe') {
                    return (...values: Parameters<Tx['$queryRawUnsafe']>) => observeLazyPrismaQuery(
                        inner.$queryRawUnsafe(...values), () => ({
                            started() {
                                if (values[0].includes('FROM "DeploymentEnvironment"') && values[0].includes('FOR UPDATE')) {
                                    sourceEnvironmentLockStarted.resolve();
                                }
                            },
                            settled() {},
                        }),
                    );
                }
                if (scope === 'role' && property === 'automation') {
                    return new Proxy(inner.automation, { get(model, method, modelReceiver) {
                        if (method !== (action === 'create' ? 'create' : 'updateMany')) return Reflect.get(model, method, modelReceiver);
                        return (...queryArgs: unknown[]) => observeLazyPrismaQuery(
                            Reflect.apply(Reflect.get(model, method), model, queryArgs),
                            () => ({ started() {}, settled() {} }), undefined,
                            async consume => {
                                const row = await consume();
                                releaseSource.resolve();
                                // Delay this real SQL response before role publication.
                                // A template lock is the alternative ending fact: it
                                // waits on this writer, which must be allowed to finish.
                                await Promise.race([sourceFinished.promise, sourceEnvironmentLockStarted.promise]);
                                return row;
                            },
                        );
                    } });
                }
                if (property !== observedModel) return Reflect.get(inner, property, innerReceiver);
                return new Proxy(Reflect.get(inner, property, innerReceiver), { get(model, method, modelReceiver) {
                    if (method !== observedMethod) return Reflect.get(model, method, modelReceiver);
                    return (...queryArgs: unknown[]) => observeLazyPrismaQuery(
                        Reflect.apply(Reflect.get(model, method), model, queryArgs),
                        () => ({ started() {}, settled() {} }), undefined, async consume => {
                            const row = await consume();
                            if (scope === 'source' && !heldCensus) {
                                heldCensus = true;
                                captured.resolve();
                                await releaseSource.promise;
                            }
                            if (scope === 'role' && row && typeof row === 'object'
                                && 'id' in row && row.id === source.source.id && 'revision' in row
                                && typeof row.revision === 'number') roleSourceRevisions.push(row.revision);
                            return row;
                        },
                    );
                } });
            },
        })), ...args.slice(1)]);
    } });
    const replace = operation.run('source', () => inTx(tx =>
        updateProjectSourceInTx(tx, owner.id, { serverId, sourceId: source.source.id,
            expectedRevision: source.source.revision, patch: { repository: { ...repository,
                repository: { nameWithOwner: 'owner/replacement', cloneUrl: 'https://github.example/owner/replacement.git' } } } }),
    { isolationLevel: 'Serializable', transactionClass: 'preview-retirement-contract' }))
        .finally(() => { sourceFinished.resolve(); });
    const replacementOutcome = Promise.allSettled([replace]);
    let creationOutcome: Promise<PromiseSettledResult<unknown>[]> | undefined;
    try {
        await Promise.race([captured.promise, replace.then(() => { throw new Error('Source never reached its census'); })]);
        creationOutcome = Promise.allSettled([operation.run('role', () => action === 'create'
            ? createAutomation({ accountId: owner.id, input: roleInput })
            : updateAutomation({ accountId: owner.id, automationId: admissionId, input: { enabled: true } }))])
            .finally(() => { releaseSource.resolve(); });
        const [replacement, creation] = await Promise.all([replacementOutcome, creationOutcome]);
        if (replacement[0].status === 'rejected') throw replacement[0].reason;
        if (creation[0].status === 'rejected') throw creation[0].reason;
        expect(replacement[0].value).toMatchObject({ ok: true });
        const currentSource = await db.projectSource.findUniqueOrThrow({ where: { id: source.source.id } });
        const currentRole = await db.automation.findUniqueOrThrow({ where: { id: admissionId } });
        expect(roleSourceRevisions).toContain(source.source.revision);
        // A role admitted before replacement must retire. A legitimate retry
        // may instead admit a new enabled role against the replacement Source.
        expect(currentRole.enabled && roleSourceRevisions.at(-1) !== currentSource.revision).toBe(false);
    } finally {
        releaseSource.resolve();
        await replacementOutcome;
        await creationOutcome;
        db.$transaction = transaction;
    }
}, 60_000);
