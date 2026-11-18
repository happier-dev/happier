import { ARTIFACT_LIST_PAGE_MAX_ITEMS_V1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1 } from '@happier-dev/protocol/artifacts/deploymentArtifactKindsV1';
import type { DeploymentDomainPageInputV1, DeploymentDataPageInputV1, DeploymentDomainPageSuccessV1, DeploymentDataPageSuccessV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { prismaRuntime, getDbProviderFromEnv } from '@/storage/prisma';
import { resolveDbSqlDialect } from '@/config/databaseProvider';
import type { AccountStatus } from '@/storage/enums.generated';
import type { Tx } from '@/storage/inTx';
import { SERVER_IDENTITY_CACHE_KEY, projectCurrentServerIdentityId } from '@/app/serverIdentity/serverIdentity';
import { projectSourceAccessCaptureSql, resolveProjectSourceAccessFromCapture, type ProjectSourceAccessCapture } from '@/app/projects/sources/projectSourceReadCapture';
import { resolveProjectSourcesAccessInTx, type ProjectSourceAccessResult } from '@/app/projects/sources/projectSourceService';
import { artifactPageReadCaptureSql, materializeArtifactPageRead, type ArtifactPageReadCapture } from '@/app/artifacts/artifactPageReadCapture';
import { projectArtifactSourceReadersFromFacts } from '@/app/artifacts/artifactSourceReaders';
import { readArtifactForCallerInTx } from '@/app/artifacts/artifactAccessService';
import { projectArtifactHttpRead } from '@/app/artifacts/artifactHttpRead';
import { deploymentFailure, projectDeploymentSourceAdmission, type DeploymentAuthentication, type DeploymentFailure } from './deploymentAdmission';
import { projectDeploymentEnvironmentHeader, type DeploymentEnvironmentRow } from './deploymentEnvironmentService';
import { projectDeploymentDomainHeader } from './deploymentDomainService';
import { projectDeploymentListRow, projectDeploymentSourcePresentation } from './deploymentListProjection';
import { admitDeploymentStoredContentsInTx, projectDeploymentStoredContentAuthority, projectDeploymentStoredContentRevision, type DeploymentContentReference } from './deploymentStoredContent';
import { openDeploymentReadCursor, refuseDeploymentReadCursor, sealDeploymentReadCursor } from './deploymentReadCursor';
import { deploymentEnvironmentPrincipalSelect, type DeploymentEnvironmentPrincipalRow } from './deploymentEnvironmentDeployers';

type Kind = 'domains' | 'data';
type Input = DeploymentDomainPageInputV1 | DeploymentDataPageInputV1;
type Environment = DeploymentEnvironmentRow & {
    principals: DeploymentEnvironmentPrincipalRow[];
    previewCompanionOfEnvironment: { previewTemplateEnvironmentId: string | null } | null;
};
type Domain = Parameters<typeof projectDeploymentDomainHeader>[0];
type CapturedDates<T, K extends keyof T> = Omit<T, K> & { [P in K]: T[P] extends Date ? number : number | null };
type CapturedEnvironment = CapturedDates<Environment, 'createdAt' | 'updatedAt' | 'deletedAt'>;
type CapturedDomain = CapturedDates<Domain, 'createdAt' | 'updatedAt' | 'deletedAt' | 'observedAt'>;
type Candidate = { key: string; environment: Environment; domain: Domain | null;
    environmentArtifact: ArtifactPageReadCapture | null; domainArtifact: ArtifactPageReadCapture | null };
type CapturedCandidate = Omit<Candidate, 'environment' | 'domain'> & { environment: CapturedEnvironment; domain: CapturedDomain | null };
type Capture = { serverIdentity: string | null; sources: ProjectSourceAccessCapture; candidates: CapturedCandidate[] };

/** Only the finite candidate window is captured; Source and Artifact owners decide all access after it. */
async function capturePostgresPage(tx: Tx, actorAccountId: string, input: Input, kind: Kind, cursor: string | undefined, limit: number, authentication: DeploymentAuthentication) {
    const sql = prismaRuntime.sql;
    const key = kind === 'domains' ? sql`d."id"` : sql`e."id"`;
    const domain = kind === 'domains' ? sql`to_jsonb(d) || jsonb_build_object(
        'createdAt', EXTRACT(EPOCH FROM d."createdAt") * 1000, 'updatedAt', EXTRACT(EPOCH FROM d."updatedAt") * 1000,
        'deletedAt', EXTRACT(EPOCH FROM d."deletedAt") * 1000, 'observedAt', EXTRACT(EPOCH FROM d."observedAt") * 1000)` : sql`NULL::jsonb`;
    const rows = await tx.$queryRaw<Capture[]>(sql`WITH page AS MATERIALIZED (
        SELECT ${key} AS key, e."projectSourceId", e."contentArtifactId" AS "environmentArtifactId",
            ${kind === 'domains' ? sql`d."contentArtifactId"` : sql`NULL::text`} AS "domainArtifactId",
            to_jsonb(e) || jsonb_build_object(
                'createdAt', EXTRACT(EPOCH FROM e."createdAt") * 1000, 'updatedAt', EXTRACT(EPOCH FROM e."updatedAt") * 1000,
                'deletedAt', EXTRACT(EPOCH FROM e."deletedAt") * 1000,
                'principals', COALESCE((SELECT jsonb_agg(jsonb_build_object('purpose', dp."purpose", 'principalKind', dp."principalKind",
                        'principalId', dp."principalId", 'principalTeamId', dp."principalTeamId"))
                    FROM "DeploymentEnvironmentDeployer" dp WHERE dp."environmentId" = e."id"), '[]'::jsonb),
                'previewCompanionOfEnvironment', (SELECT jsonb_build_object('previewTemplateEnvironmentId', parent."previewTemplateEnvironmentId")
                    FROM "DeploymentEnvironment" parent WHERE parent."id" = e."previewCompanionOfEnvironmentId")) AS environment,
            ${domain} AS domain
        FROM "DeploymentEnvironment" e ${kind === 'domains' ? sql`JOIN "DeploymentDomain" d ON d."environmentId" = e."id"` : sql``}
        WHERE e."deletedAt" IS NULL ${kind === 'domains' ? sql`AND d."deletedAt" IS NULL` : sql``}
            ${input.projectSourceId ? sql`AND e."projectSourceId" = ${input.projectSourceId}` : sql``}
            ${cursor ? sql`AND ${key} > ${cursor}` : sql``}
        ORDER BY ${key} ASC LIMIT ${limit + 1}
    ) SELECT (SELECT "value" FROM "SimpleCache" WHERE "key" = ${SERVER_IDENTITY_CACHE_KEY}) AS "serverIdentity",
        (${projectSourceAccessCaptureSql({ actorAccountId: sql`${actorAccountId}`, sourceIds: sql`SELECT DISTINCT "projectSourceId" FROM page`, env: authentication.env })}) AS sources,
        COALESCE((SELECT jsonb_agg(jsonb_build_object('key', p.key, 'environment', p.environment, 'domain', p.domain,
            'environmentArtifact', ea.capture, 'domainArtifact', da.capture) ORDER BY p.key)
            FROM page p
            LEFT JOIN LATERAL (${artifactPageReadCaptureSql({ actorAccountId, artifactId: sql`p."environmentArtifactId"` })}) ea ON true
            LEFT JOIN LATERAL (${artifactPageReadCaptureSql({ actorAccountId, artifactId: sql`p."domainArtifactId"` })}) da ON true), '[]'::jsonb) AS candidates`);
    const capture = rows[0]!;
    const candidates: Candidate[] = capture.candidates.map(row => ({ ...row,
        environment: { ...row.environment, createdAt: new Date(row.environment.createdAt), updatedAt: new Date(row.environment.updatedAt),
            deletedAt: row.environment.deletedAt === null ? null : new Date(row.environment.deletedAt) },
        domain: row.domain ? { ...row.domain, createdAt: new Date(row.domain.createdAt), updatedAt: new Date(row.domain.updatedAt),
            deletedAt: row.domain.deletedAt === null ? null : new Date(row.domain.deletedAt),
            observedAt: row.domain.observedAt === null ? null : new Date(row.domain.observedAt) } : null,
    }));
    return { capture, candidates };
}

async function capturePortablePage(tx: Tx, input: Input, kind: Kind, cursor: string | undefined, limit: number) {
    const include = { principals: deploymentEnvironmentPrincipalSelect,
        previewCompanionOfEnvironment: { select: { previewTemplateEnvironmentId: true } } } as const;
    const environmentWhere = { deletedAt: null, ...(input.projectSourceId ? { projectSourceId: input.projectSourceId } : {}) };
    const candidates: Candidate[] = kind === 'domains'
        ? (await tx.deploymentDomain.findMany({ where: { deletedAt: null, environment: environmentWhere,
            ...(cursor ? { id: { gt: cursor } } : {}) }, include: { environment: { include } }, orderBy: { id: 'asc' }, take: limit + 1 }))
            .map(row => ({ key: row.id, environment: row.environment, domain: row, environmentArtifact: null, domainArtifact: null }))
        : (await tx.deploymentEnvironment.findMany({ where: { ...environmentWhere, ...(cursor ? { id: { gt: cursor } } : {}) },
            include, orderBy: { id: 'asc' }, take: limit + 1 }))
            .map(row => ({ key: row.id, environment: row, domain: null, environmentArtifact: null, domainArtifact: null }));
    return { candidates, serverIdentity: (await tx.simpleCache.findUnique({ where: { key: SERVER_IDENTITY_CACHE_KEY }, select: { value: true } }))?.value ?? null };
}

function listAccountPage(tx: Tx, actorAccountId: string, input: Input, kind: 'domains', authentication: DeploymentAuthentication): Promise<DeploymentDomainPageSuccessV1 | DeploymentFailure>;
function listAccountPage(tx: Tx, actorAccountId: string, input: Input, kind: 'data', authentication: DeploymentAuthentication): Promise<DeploymentDataPageSuccessV1 | DeploymentFailure>;
async function listAccountPage(tx: Tx, actorAccountId: string, input: Input, kind: Kind, authentication: DeploymentAuthentication,
): Promise<DeploymentDomainPageSuccessV1 | DeploymentDataPageSuccessV1 | DeploymentFailure> {
    const cursorInput = { ...input, pageKind: kind };
    let cursor: string | undefined;
    try {
        cursor = openDeploymentReadCursor(actorAccountId, cursorInput);
    } catch { return refuseDeploymentReadCursor(); }
    const limit = Math.min(input.limit ?? ARTIFACT_LIST_PAGE_MAX_ITEMS_V1, ARTIFACT_LIST_PAGE_MAX_ITEMS_V1);
    const postgres = resolveDbSqlDialect(getDbProviderFromEnv(process.env, 'postgres')) === 'postgres';
    let candidates: Candidate[];
    let sources: ReadonlyMap<string, ProjectSourceAccessResult>;
    let actorStatus: AccountStatus;
    let serverIdentity: string | null;
    if (postgres) {
        const result = await capturePostgresPage(tx, actorAccountId, input, kind, cursor, limit, authentication);
        candidates = result.candidates;
        serverIdentity = projectCurrentServerIdentityId(result.capture.serverIdentity);
        sources = await resolveProjectSourceAccessFromCapture(tx, { actorAccountId, authentication, capture: result.capture.sources });
        actorStatus = result.capture.sources.actor?.status ?? 'disabled';
    } else {
        const result = await capturePortablePage(tx, input, kind, cursor, limit);
        candidates = result.candidates;
        serverIdentity = projectCurrentServerIdentityId(result.serverIdentity);
        sources = await resolveProjectSourcesAccessInTx(tx, actorAccountId, [...new Set(candidates.map(row => row.environment.projectSourceId))], authentication, { includeDeleted: true });
        actorStatus = 'active'; // Portable reads below acquire the caller through the incumbent Artifact owner.
    }
    if (serverIdentity !== input.serverId) return deploymentFailure('deployment_unavailable', {
        phase: 'deployment.account.page.server', causeKind: 'server_mismatch',
    });
    const artifacts = new Map<string, ReturnType<typeof projectArtifactHttpRead>>();
    const domains: { domain: ReturnType<typeof projectDeploymentDomainHeader>; environment: ReturnType<typeof projectDeploymentEnvironmentHeader> }[] = [];
    const projectSources = new Map<string, ReturnType<typeof projectDeploymentSourcePresentation>>();
    const data: { environment: ReturnType<typeof projectDeploymentEnvironmentHeader> }[] = [];
    let partial = false;
    for (const row of candidates.slice(0, limit)) {
        const source = sources.get(row.environment.projectSourceId);
        if (!source?.ok) {
            if (source?.failure.error === 'source_invalid') partial = true;
            continue;
        }
        const admission = projectDeploymentSourceAdmission(source);
        const selected: { reference: DeploymentContentReference; kind: string; capture: ArtifactPageReadCapture | null }[] = [
            { reference: row.environment, kind: DEPLOYMENT_ENVIRONMENT_ARTIFACT_STORED_KIND_V1, capture: row.environmentArtifact },
            ...(row.domain ? [{ reference: row.domain, kind: DEPLOYMENT_DOMAIN_ARTIFACT_STORED_KIND_V1, capture: row.domainArtifact }] : []),
        ];
        const opened: ReturnType<typeof projectArtifactHttpRead>[] = [];
        for (const item of selected) {
            if (postgres) {
                const readers = item.capture ? projectArtifactSourceReadersFromFacts({ artifact: item.capture,
                    reference: { projectSourceId: row.environment.projectSourceId, contentArtifactId: item.reference.contentArtifactId, expectedStoredKind: item.kind },
                    admittedSource: source, readers: [{ accountId: actorAccountId, account: { status: actorStatus } }] }) : [];
                const read = materializeArtifactPageRead(item.capture, { actorAccountId, sourceReaderAccounts: readers });
                if (!read.ok || projectDeploymentStoredContentAuthority(read.artifact, admission.owner, item.kind, 'read', readers.length > 0)
                    || projectDeploymentStoredContentRevision(read.artifact, item.reference)) break;
                opened.push(projectArtifactHttpRead(read.artifact));
            } else {
                const [failure] = await admitDeploymentStoredContentsInTx(tx, actorAccountId, admission.owner,
                    [{ reference: item.reference, expectedStoredKind: item.kind, access: 'read' }]);
                if (failure) break;
                const read = await readArtifactForCallerInTx(tx, { actorAccountId, artifactId: item.reference.contentArtifactId });
                if (!read.ok) break;
                opened.push(projectArtifactHttpRead(read.artifact));
            }
        }
        if (opened.length !== selected.length) { partial = true; continue; }
        const environment = projectDeploymentListRow(() => projectDeploymentEnvironmentHeader(row.environment, input.serverId, admission));
        const domain = row.domain ? projectDeploymentListRow(() => projectDeploymentDomainHeader(row.domain!)) : null;
        if (!environment || row.domain && !domain) { partial = true; continue; }
        if (domain) domains.push({ domain, environment });
        else data.push({ environment });
        if (!projectSources.has(admission.source.id)) {
            projectSources.set(admission.source.id, projectDeploymentSourcePresentation(admission.source));
        }
        for (const artifact of opened) artifacts.set(artifact.id, artifact);
    }
    const page = { artifacts: [...artifacts.values()], projectSources: [...projectSources.values()],
        nextCursor: candidates.length > limit ? sealDeploymentReadCursor(actorAccountId, cursorInput, candidates[limit - 1]!.key) : null,
        coverage: partial ? 'partial' as const : 'complete' as const };
    return kind === 'domains' ? { ok: true as const, items: domains, ...page }
        : { ok: true as const, items: data, ...page };
}

export function listDeploymentDomainPageInTx(tx: Tx, actorAccountId: string, input: DeploymentDomainPageInputV1, authentication: DeploymentAuthentication = {}) {
    return listAccountPage(tx, actorAccountId, input, 'domains', authentication);
}
export function listDeploymentDataPageInTx(tx: Tx, actorAccountId: string, input: DeploymentDataPageInputV1, authentication: DeploymentAuthentication = {}) {
    return listAccountPage(tx, actorAccountId, input, 'data', authentication);
}
