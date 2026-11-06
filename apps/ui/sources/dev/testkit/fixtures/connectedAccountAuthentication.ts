import type { ConnectedAccountAttemptTransactionRecord } from '@happier-dev/cli-common/connectedAccounts';
import type { LazyActionAccountContext } from '@/sync/ops/actions/actionAccountContext';
import { CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS } from '@happier-dev/cli-common/connectedAccounts';

/** Passed by the suite's hoisted packaged-inventory and native asset IO mocks. */
export type ConnectedAccountAuthenticationPackagedBoundary = {
    artifacts: unknown[];
    declarations: unknown[];
    files: Map<number, Uint8Array>;
    reads: number;
};

const { compileUniversalPluginUiCommonJs } = await import('../../../../../../packages/plugin-sdk/src/ui/build/universalCommonJsCompiler');

/** Packaged inventory is the boundary; normalization and compilation stay real. */
export async function prepareAuthenticationInventory(packaged: ConnectedAccountAuthenticationPackagedBoundary,
    input: Readonly<{ manifest: unknown; target: Readonly<{ artifactId: string; exportName: string }>;
        projectPath: string; entryPath: string; packageName: string;
        additionalArtifacts?: readonly Readonly<{ target: Readonly<{ artifactId: string; exportName: string }>; entryPath: string }>[];
        deferDeclaration?: boolean; onDeclarationLoad?: () => void }>) {
    const { resolve } = await import('node:path');
    const { readWorkspacePackages, packageNameOfSpecifier, resolveWorkspaceSource } = await import('../../../../../../packages/cli-common/sourceRuntimeEntries.mjs');
    const { PluginPortableReleaseManifestV1Schema } = await import('@happier-dev/protocol/plugins/availability');
    const { projectPluginPortableUiDeclarationsV1 } = await import('@happier-dev/protocol/plugins/contributions/ui');
    const { computePluginUiArtifactFileSetSha256DigestV1, computePluginUiArtifactSha256DigestV1,
        PluginUiArtifactsManifestEntryV2Schema } = await import('@happier-dev/protocol/plugins/ui');
    const manifest = PluginPortableReleaseManifestV1Schema.parse(input.manifest);
    const root = resolve(import.meta.dirname, '../../../../../..');
    const packages = await readWorkspacePackages(root);
    const graphs: ReturnType<typeof PluginUiArtifactsManifestEntryV2Schema.parse>[] = [];
    for (const artifact of [{ target: input.target, entryPath: input.entryPath }, ...(input.additionalArtifacts ?? [])]) {
        const compiled = await compileUniversalPluginUiCommonJs({
            projectRoot: resolve(root, input.projectPath), entryPath: resolve(root, artifact.entryPath),
            artifactId: artifact.target.artifactId, requestedExports: [artifact.target.exportName], exportConditions: ['happier-source'],
            resolveSourceImport: specifier => packages.has(packageNameOfSpecifier(specifier))
                ? resolveWorkspaceSource(packages, specifier, { conditions: ['react-native', 'browser'] }) : undefined,
        });
        const graph = PluginUiArtifactsManifestEntryV2Schema.parse({ artifactId: compiled.artifactId, tier: 'reactNative',
            entry: compiled.relativePath, digest: computePluginUiArtifactFileSetSha256DigestV1([{ relativePath: compiled.relativePath, bytes: compiled.bytes }]),
            files: [{ relativePath: compiled.relativePath, digest: computePluginUiArtifactSha256DigestV1(compiled.bytes), byteSize: compiled.bytes.length }],
            builtWith: { bundler: 'esbuild', version: compiled.esbuildVersion }, executable: { exports: compiled.exports }, hostUiApiRange: '^1.0.0' });
        const asset = packaged.files.size + 1;
        packaged.files.set(asset, compiled.bytes);
        packaged.artifacts.push({ pluginId: manifest.id, artifactId: graph.artifactId, tier: 'reactNative',
            digest: graph.digest, releaseVersion: manifest.version, artifactGraph: graph,
            files: [{ relativePath: compiled.relativePath, asset }] });
        graphs.push(graph);
    }
    const declaration = { pluginId: manifest.id, pluginVersion: manifest.version, displayName: 'Public authentication',
        packageName: input.packageName, normalizedManifest: manifest,
        entriesById: projectPluginPortableUiDeclarationsV1(manifest, graphs), artifactGraphs: graphs };
    if (input.deferDeclaration) {
        const empty = PluginPortableReleaseManifestV1Schema.parse({ schemaVersion: 2, id: manifest.id,
            version: manifest.version, displayName: manifest.displayName, runtime: { apiVersion: 1 }, contributes: {} });
        const { connectedAccountDescriptors: _descriptors, ...otherContributions } = manifest.contributes;
        const { connectedAccountDescriptors: _emptyDescriptors, ...emptyContributions } = empty.contributes;
        if (JSON.stringify(otherContributions) !== JSON.stringify(emptyContributions)) {
            throw new Error('Deferred authentication presentation fixture must be descriptor-only');
        }
        // This descriptor-only presentation equals the admitted manifest;
        // every unrelated contribution family has its canonical empty value.
        packaged.declarations.push({ ...declaration, normalizedManifest: undefined, presentationManifest: manifest,
            loadDeclaration: async () => { input.onDeclarationLoad?.(); return declaration; } });
    } else packaged.declarations.push(declaration);
    return { pluginId: manifest.id, localId: 'example' };
}

/** Stateful HTTP/database boundary for the actual addressed transaction API. */
export async function answerAttemptTransaction(request: URL, init: RequestInit | undefined,
    transactions: Map<string, ConnectedAccountAttemptTransactionRecord>): Promise<Response | null> {
    const prefix = '/v2/connect/connected-account-attempt-transactions/';
    if (!request.pathname.startsWith(prefix)) return null;
    const method = init?.method ?? 'GET';
    const address = request.pathname.slice(prefix.length).split('/');
    if (method === 'GET' && address[0] === 'pending' && address.length === 1) {
        const machineId = request.searchParams.get('machineId');
        return Response.json({ attempts: [...transactions].flatMap(([attemptId, record]) => {
            const scope = record.scope;
            if (scope.phase === 'starting' || record.expiresAtMs <= Date.now()
                || scope.service.pluginId !== request.searchParams.get('pluginId')
                || scope.service.localId !== request.searchParams.get('localId')
                || scope.machineId !== (machineId ?? undefined)) return [];
            return [{ attemptId, kind: record.kind, modeId: scope.modeId, intent: scope.intent,
                phase: scope.phase, createdAtMs: scope.createdAtMs, expiresAtMs: record.expiresAtMs }];
        }) });
    }
    if (method === 'GET') {
        const current = address.length === 1 ? transactions.get(decodeURIComponent(address[0]!)) : undefined;
        return current ? Response.json(current)
            : Response.json({ error: 'connected_account_attempt_transaction_not_found' }, { status: 404 });
    }
    const [kind, encodedAttemptId] = address;
    if (address.length !== 2 || (kind !== 'manual' && kind !== 'oauth' && kind !== 'device') || !encodedAttemptId) {
        throw new Error('Fixture only accepts the transaction kinds supported by the actual API');
    }
    const key = decodeURIComponent(encodedAttemptId);
    const current = transactions.get(key);
    if (method === 'DELETE') { transactions.delete(key); return Response.json({ status: 'deleted' }); }
    const body = await new Response(init?.body).json() as Omit<ConnectedAccountAttemptTransactionRecord, 'kind' | 'revision' | 'expiresAtMs'>
        & { expiresAtMs?: number; expectedRevision?: number };
    if ((method === 'POST' && current) || (method === 'PATCH' && body.expectedRevision !== current?.revision)) {
        return Response.json({ error: 'connected_account_attempt_transaction_conflict' }, { status: 409 });
    }
    // Match the server POST's existing finite lifetime default. PATCH always
    // carries the finite deadline returned by that producer.
    const expiresAtMs = body.expiresAtMs ?? (method === 'POST' ? Date.now() + CONNECTED_ACCOUNT_ATTEMPT_TRANSACTION_LIFETIME_MS : undefined);
    if (expiresAtMs === undefined) return Response.json({ error: 'connected_account_attempt_transaction_expiry_invalid' }, { status: 400 });
    const next: ConnectedAccountAttemptTransactionRecord = { kind, revision: (current?.revision ?? 0) + 1, content: body.content, expiresAtMs, scope: body.scope };
    transactions.set(key, next);
    return Response.json(next);
}

/** A fake native RPC host persists its real finite address through the shared owner. */
export async function createNativeAttemptAddressBoundary(account: LazyActionAccountContext, machineId: string) {
    const [{ createConnectedAccountAttemptTransactionAdapters, generatePkceCodes },
        { createUiConnectedAccountAttemptTransactionApi }, { createUiConnectedAccountContent },
        { getRandomBytes }, { digest }] = await Promise.all([
        import('@happier-dev/cli-common/connectedAccounts'),
        import('@/sync/ops/connectedAccounts/connectedAccountAttemptTransactions'),
        import('@/sync/ops/connectedAccounts/connectedAccountContent'),
        import('@/platform/cryptoRandom'),
        import('@/platform/digest'),
    ]);
    const content = createUiConnectedAccountContent(account);
    return createConnectedAccountAttemptTransactionAdapters({
        api: createUiConnectedAccountAttemptTransactionApi(account),
        getMachineId: () => machineId,
        randomBytes: getRandomBytes,
        generatePkceCodes: () => generatePkceCodes({ randomBytes: getRandomBytes,
            sha256: bytes => digest('SHA-256', bytes) }),
        seal: async payload => content.seal('attempt', await content.resolveAccountMode('fresh-authority'), payload),
        open: async record => {
            const opened = content.open('attempt', await content.resolveAccountMode(), record.content);
            if (opened === null) throw new Error('Native fixture attempt cannot be opened');
            return opened;
        },
    }).address;
}
