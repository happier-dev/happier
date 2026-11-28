import type { DeploymentOwnServerContentV1 } from '@happier-dev/deployments/contracts/v1';
import * as React from 'react';
import {
  createDeploymentReadControllerV1,
  type DeploymentReadTransportV1,
} from '@happier-dev/deployments';
import type { DeploymentReceiptHeaderV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createDeploymentEnvironmentDetailV1, createDeploymentTargetLinkHeaderV1, createDeploymentReceiptDetailV1 } from '@happier-dev/deployments/testing/v1';
import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';

import { formatSharedSavedSecretRefV1 } from '@happier-dev/protocol/account/settings/savedSecretReferenceV1';
import { ProjectDeploymentsView } from '@/components/projects/deployments/ProjectDeploymentsBody';
import { createTelemetryCaptureFixtureInvoke, TelemetryCaptureFixtureProvider } from '@/dev/testkit/fixtures/telemetryCaptureFixtures';
import { showDeploymentDispositionSheet, type DeploymentDispositionSheetInput } from '@/components/projects/deployments/DeploymentDispositionSheet';
import { deploymentSheetStyles, showDeploymentSheet } from '@/components/projects/deployments/deploymentSheet';
import { DeploymentPreparationRecognized } from '@/components/projects/deployments/DeploymentPreparationRecognized';
import { ActionInputFields } from '@/components/sessions/actions/ActionInputFields';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { t } from '@/text';
import { View } from 'react-native';
import { HappyError } from '@/utils/errors/errors';
import { useAllMachines } from '@/sync/store/hooks';
import { createMachineFixture, createMachineMetadataFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { publishMachineInventoryForTest } from '@/dev/testkit/harness/machinePresence';
import { getActiveServerId } from '@/sync/domains/server/serverProfiles';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';

/**
 * Dev-only specimen of Project → Deployments (lab d1/d3) drawn through the real page over a fixture network
 * boundary: two Environments, a short receipt history and the serving receipt in `?receipt=<state>`.
 * `?state=empty|error|loading` shows the page states. `?cancellable=true|false` is the receipt read's cancel fact
 * (absent: an older server that does not say). It proves composition only; the loaded page is judged
 * on the QA Account's real Environments.
 */
const ACCOUNT = 'account-owner';
const RAILWAY_TARGET = { pluginId: 'happier.deploy.railway', localId: 'runtime' };
const RAILWAY_LINK = {
  providerEnvironment: { kind: 'native', selection: { projectId: 'shop-project', environmentId: 'shop-staging', serviceId: 'store-api' } },
  providerIdentity: { providerAccountId: 'shop-project', providerEnvironment: 'shop-staging', providerResourceId: 'store-api' },
  credentialPrincipal: { kind: 'account', accountId: ACCOUNT,
    purpose: { consumer: { pluginId: RAILWAY_TARGET.pluginId, localId: 'service-link' }, purpose: 'cloud-api' },
    target: { kind: 'account', account: { service: { pluginId: 'happier.machine.railway', localId: 'railway-account' }, accountId: 'railway' } },
  },
  sourceMethod: 'gitIntegration',
} as const;
const RAILWAY_DATA_TARGET = { pluginId: 'happier.deploy.railway-data', localId: 'postgresql' };
const RAILWAY_DATA_LINK_ID = 'railway-orders';
// Railway names a service by an opaque UUID: the page must read the link's service name, never this id.
const RAILWAY_DATA_SELECTION = { ...RAILWAY_LINK.providerEnvironment.selection, serviceId: '3f2a9c1e-7b4d-4e8a-9f10-2c6d5b8e1a47' };
const railwayTabs = (tabs: string | undefined) => tabs === 'railway-domains' || tabs === 'railway-database';
const SPECIMEN_COLLECTOR_ID = 'machine-collector';
const HOUR = 3_600_000;
const SPECIMEN_NOW = Date.now();
const SHOWN = Object.freeze({ mounted: true, visible: true, focused: true });

type ReceiptState = DeploymentReceiptHeaderV1['state'];

const SHAS = { a: 'b81e0d4c2f', b: '7f3e2b1a90', c: 'a41c09e5d3', d: 'c7f2a8e011' } as const;
const shaOf = (id: string) => (SHAS[id[id.length - 1] as keyof typeof SHAS] ?? SHAS.a).padEnd(40, '0');
/** The masked stage-output tail a real deploy log ends with (lab d3 `failed` / `unknown`). */
const LOG_TAIL: Partial<Record<ReceiptState, string>> = {
  failed: [
    '10:44:51 web  Recreated · release starting',
    '10:44:52 web: unhealthy · GET /healthz → 502 Bad Gateway',
    '10:44:52 Error: connect ECONNREFUSED 10.0.3.4:5432',
    '10:44:52 Health: database unreachable',
  ].join('\n'),
  outcome_unknown: [
    '10:44:49 $ docker compose -p happier-staging up --detach --wait --remove-orphans web worker',
    '10:44:50 web  Recreate',
    '10:46:50 No answer from the machine after the roll-out command',
  ].join('\n'),
};

/**
 * Each step's masked lines, as the stage-output sink wrote them (lab d3 `live|failed`). `build` and `rollout` run
 * long enough to page; the reader below serves them the way `deployments.logs.read` does (tail or cursor pages).
 */
const STEP_LOGS: Record<string, readonly string[]> = {
  railwayBuild: [
    '10:08:10 Checkout release at 7f3e2b1',
    '10:08:13 Installing dependencies with pnpm',
    '10:08:35 Building checkout-api',
    '10:09:02 Published the build image',
  ],
  sync: [
    '10:08:11.07 Release 39 · 7f3e2b1 "fix(checkout): keep the cart after sign-in"',
    '10:08:11.14 Source github.com/happier-dev/happier at 7f3e2b1 (PR #142)',
    '10:08:12.21 $ sync → vps-2:/srv/happier/production-api/releases/39',
    '10:08:12.28 1,284 files · 18.2 MB sent · 3.1 MB unchanged',
    '10:08:12.35 Provenance written: release.json (commit, PR, actor Ana Ruiz, Session "Keep cart after sign-in")',
    '10:08:13.42 Data folder ./uploads → shared/uploads · kept across deploys',
    '10:08:13.49 Secrets: 5 sealed for this environment · opened for release 39 only',
    '10:08:13.56 DATABASE_URL=•••••• redacted',
  ],
  build: [
    '10:08:14.07 $ docker compose -p happier-production-api build',
    '10:08:14.14 #1 [web internal] load build definition from Dockerfile',
    '10:08:14.21 #4 [web base 1/3] FROM docker.io/library/node:22.20-slim',
    '10:08:15.02 #9 [web deps 2/3] RUN pnpm install --frozen-lockfile',
    '10:08:31.40 #9 Packages: +1,412',
    '10:08:44.18 #9 Done in 29.1s',
    '10:08:44.90 #12 [web build 3/3] RUN pnpm build',
    '10:08:45.10 vite v6.3.1 building for production…',
    '10:09:02.17 ✓ 1,904 modules transformed.',
  ],
  migrate: [
    '10:09:26.02 $ docker compose run --rm web pnpm db:migrate',
    '10:09:27.40 Applied 20261030_cart_owner (1 statement)',
    '10:09:28.11 Schema is current',
  ],
  rollout: [
    '10:44:38.07 $ docker compose -p happier-production-api up --detach --wait --remove-orphans web worker',
    '10:44:38.14 postgres  Running · unchanged, keeps serving',
    '10:44:39.21 web  Recreated · release 38 stopped, 39 starting',
    '10:44:39.28 worker  Recreated',
    '10:44:39.35 web: starting',
    ...Array.from({ length: 12 }, (_, index) => `10:44:${String(40 + index).padStart(2, '0')}.00 web: waiting for health · attempt ${index + 1}`),
    '10:44:52.30 web: unhealthy · GET /healthz → 502 Bad Gateway',
    '10:44:52.37 Error: connect ECONNREFUSED 10.0.3.4:5432',
    '10:44:52.44 Health: database unreachable',
  ],
  route: ['10:44:53.01 Route kept on release 38'],
};
/** Lines per specimen page: small, so a long step really pages for download. */
const STEP_PAGE_LINES = 6;

function readStepLog(input: Readonly<{ ref?: string; tail?: true; cursor?: { sourceRevision: string; token: string } }>) {
  const lines = STEP_LOGS[input.ref ?? ''] ?? null;
  if (!lines) return { ok: true as const, logs: { kind: 'unavailable' as const, reason: 'admission_unavailable' as const } };
  const sourceRevision = `specimen-${input.ref}`;
  const start = input.cursor ? Number(input.cursor.token)
    : input.tail ? Math.max(0, lines.length - STEP_PAGE_LINES * 2) : 0;
  const end = Math.min(lines.length, start + (input.tail && !input.cursor ? STEP_PAGE_LINES * 2 : STEP_PAGE_LINES));
  const text = lines.slice(start, end).map((line) => `${line}\n`).join('');
  return { ok: true as const, logs: { kind: 'page' as const, page: { sourceRevision, text,
    nextCursor: { sourceRevision, token: String(end) }, truncated: input.tail === true && start > 0 } } };
}

/**
 * The own-server facts a native receipt records (DEPLOY-SURFACES 2026-10-31): the approved input basis, the
 * incumbent it replaced, and the masked log tail. `previous` is the receipt that served before this one.
 */
function ownServerFacts(state: ReceiptState, previous: string | null,
  base: Pick<ReturnType<typeof createDeploymentReceiptDetailV1>, 'deployment'> & Readonly<{
    content: Readonly<{ sourceIntent: DeploymentOwnServerContentV1['sourceIntent'] }>;
  }>) {
  const tail = LOG_TAIL[state];
  return {
    approvedInputBasis: {
      v: 1 as const, environmentId: 'environment-staging', environmentRevision: 1,
      targetLinkId: base.deployment.targetLinkId, targetLinkRevision: 1, sourceIntent: base.content.sourceIntent,
      manifestFingerprint: 'manifest', configInputDigests: [], physicalProjectName: 'happier-staging', toolVersion: '2.40.1',
      services: ['web', 'worker', 'postgres'], profiles: [], members: [{ machineId: 'machine-a', installationId: 'installation-a' }],
      bindings: [], images: [], ownServer: { rollout: 'recreate' as const, autoRestorePreviousRelease: false },
    },
    rollbackTarget: previous ? { deploymentId: previous, revision: { kind: 'repository' as const, sha: shaOf(previous) } } : null,
    stageLogs: [{ machineId: 'machine-a', installationId: 'installation-a',
      relativePath: '.happier/deploy.log' as const, ...(tail ? { excerpt: { text: tail, truncated: true } } : {}),
      // The sink's per-step ranges; a null end is the phase still writing.
      steps: startedSteps(state).map((ref, index, all) => ({ ref,
        range: { start: index * 1_000, end: index === all.length - 1 && state === 'running' ? null : (index + 1) * 1_000 } })) }],
  };
}

/** The steps that wrote to the log before the receipt's state (the rest never started). */
function startedSteps(state: ReceiptState): readonly string[] {
  if (state === 'running' || state === 'queued') return ['sync', 'build'];
  if (state === 'failed' || state === 'outcome_unknown') return ['sync', 'build', 'migrate', 'rollout'];
  return ['sync', 'build', 'migrate', 'rollout', 'route'];
}

function receiptFor(
  id: string,
  state: ReceiptState,
  ageHours: number,
  operation: 'deploy' | 'rollback' = 'deploy',
  previous: string | null = null,
  subject?: string,
) {
  const base = createDeploymentReceiptDetailV1();
  const requestedAtMs = SPECIMEN_NOW - ageHours * HOUR;
  const settled =
    state === 'succeeded' || state === 'failed' || state === 'cancelled';
  const step = (
    stepId: string,
    label: string,
    stepState: 'succeeded' | 'running' | 'pending' | 'failed' | 'skipped' | 'outcome_unknown',
    durationMs?: number,
  ) => ({
    id: stepId,
    label,
    state: stepState,
    ...(durationMs !== undefined ? { durationMs } : {}),
  });
  const running =
    state === 'running' || state === 'queued';
  const steps =
    state === 'failed'
      ? [
          step('sync', 'Sync', 'succeeded', 4_000),
          step('build', 'Build', 'succeeded', 72_000),
          step('migrate', 'Migrate', 'succeeded', 3_000),
          step('rollout', 'Roll out', 'failed', 14_000),
          step('route', 'Route', 'skipped'),
        ]
      : state === 'outcome_unknown'
        ? [
            step('sync', 'Sync', 'succeeded', 4_000),
            step('build', 'Build', 'succeeded', 72_000),
            step('migrate', 'Migrate', 'succeeded', 3_000),
            step('rollout', 'Roll out', 'outcome_unknown'),
            step('route', 'Route', 'pending'),
          ]
      : running
          ? [
            step('sync', 'Sync', 'succeeded', 4_000),
            step('build', 'Build', 'running'),
            step('migrate', 'Migrate', 'pending'),
            step('rollout', 'Roll out', 'pending'),
            step('route', 'Route', 'pending'),
          ]
        : [
            step('sync', 'Sync', 'succeeded', 4_000),
            step('build', 'Build', 'succeeded', 72_000),
            step('migrate', 'Migrate', 'succeeded', 3_000),
            step('rollout', 'Roll out', 'succeeded', 14_000),
            step('route', 'Route', 'succeeded', 400),
          ];
  return createDeploymentReceiptDetailV1({
    deployment: createDeploymentReceiptHeaderV1({
      id,
      state,
      operation,
      requestedAtMs,
      startedAtMs: requestedAtMs + 1_000,
      ...(operation === 'rollback'
        ? { rollbackOfDeploymentId: 'deployment-c' }
        : {}),
      settledAtMs: settled ? requestedAtMs + 91_000 : undefined,
    }),
    content: {
      ...base.content,
      sourceIntent:
        base.content.sourceIntent.kind === 'repository'
          ? { ...base.content.sourceIntent, sha: shaOf(id) }
          : base.content.sourceIntent,
      ...(subject ? { commitSubject: subject } : {}),
      ...(state === 'failed' ? { failure: { code: 'native_health_check_failed', phase: 'observe' as const } } : {}),
      ownServer: ownServerFacts(state, previous, base),
      steps,
      images: SPECIMEN_IMAGES,
      machineResults: base.content.machineResults.map((result) => ({
        ...result,
        currentDeploymentId: id,
        activation:
          state === 'succeeded'
            ? 'succeeded'
            : state === 'failed'
              ? 'failed'
              : state === 'outcome_unknown'
                ? 'outcome_unknown'
                : 'pending',
        health:
          state === 'succeeded'
            ? 'healthy'
            : state === 'running_unverified'
              ? 'unverified'
              : 'unknown',
        ...(state === 'failed' ? { health: 'unhealthy' as const } : {}),
      })),
    },
  });
}

function railwayReceipt(receipt: ReturnType<typeof createDeploymentReceiptDetailV1>) {
  const { sourceIntent, commitSubject } = receipt.content;
  const { sourceMethod, ...link } = RAILWAY_LINK;
  const recorded = receipt.deployment.state;
  const state = recorded === 'running_unverified' || recorded === 'outcome_unknown' ? 'running' : recorded;
  const { rollbackOfDeploymentId: _rollback, ...deployment } = receipt.deployment;
  return createDeploymentReceiptDetailV1({ deployment: { ...deployment, operation: 'deploy' }, content: {
    sourceIntent: sourceIntent!, commitSubject, machines: [], steps: [], machineResults: [], images: [], sourceMethod,
    platform: { ...link, targetLinkRevision: 1, observation: { v: 1, state, observedAtMs: SPECIMEN_NOW,
      providerDeploymentId: `railway-${receipt.deployment.id}`, urls: ['https://store-staging.up.railway.app'],
      builtInUrls: ['https://store-staging.up.railway.app'] } },
  } });
}

const digest = (c: string) => `sha256:${c.repeat(64)}`;
/** The lab's Compose cast: two services this deploy built, one pulled by reference. */
const SPECIMEN_IMAGES = [
  { service: 'web', platform: 'linux/amd64', configDigest: digest('1'), manifestDigest: digest('2') },
  { service: 'worker', platform: 'linux/amd64', configDigest: digest('3'), manifestDigest: digest('4') },
  { service: 'postgres', platform: 'linux/amd64', configDigest: digest('5'), manifestDigest: digest('6'),
    registryReference: `docker.io/library/postgres:17.2@${digest('6')}` },
];

const RECEIPT_TITLES = [
  'fix(api): retry the Stripe webhook once',
  'feat(api): health endpoint reports queue depth',
  'feat(api): rate-limit magic links',
  'Roll back to the last good build',
];

/**
 * The fixtures name one Machine (`machine-a`); the specimen swaps in a real Machine of the signed-in Account,
 * so names, their length and their wrapping are the real ones, never a placeholder.
 */
function onMachine<T>(value: T, machineId: string | null): T {
  return machineId ? JSON.parse(JSON.stringify(value).replaceAll('"machine-a"', JSON.stringify(machineId))) as T : value;
}

const secret = (id: string, revision: number) =>
  ({ kind: 'secret' as const, ref: formatSharedSavedSecretRefV1(id), resourceRevision: revision });
/** The lab's Variables cast (r3 `variables/rows`): values, saved secrets, a reference and a build-and-runtime pair. */
const SPECIMEN_BINDINGS = [
  { purpose: 'variable' as const, name: 'DATABASE_URL', phase: 'runtime' as const, source: secret('shop-db-url', 3) },
  { purpose: 'variable' as const, name: 'SHOP_DB_HOST', phase: 'runtime' as const,
    source: { kind: 'reference' as const, environmentId: 'environment-production', export: 'db', via: 'privateNetwork' as const } },
  { purpose: 'variable' as const, name: 'STRIPE_SECRET_KEY', phase: 'runtime' as const, source: secret('stripe-live', 4) },
  { purpose: 'variable' as const, name: 'SENTRY_AUTH_TOKEN', phase: 'build' as const, source: secret('sentry-release', 1) },
  { purpose: 'variable' as const, name: 'PUBLIC_API_ORIGIN', phase: 'build' as const, source: { kind: 'value' as const, value: 'https://api.happier.dev' } },
  { purpose: 'variable' as const, name: 'PUBLIC_API_ORIGIN', phase: 'runtime' as const, source: { kind: 'value' as const, value: 'https://api.happier.dev' } },
  { purpose: 'variable' as const, name: 'LOG_LEVEL', phase: 'runtime' as const, source: { kind: 'value' as const, value: 'info' } },
  { purpose: 'variable' as const, name: 'APP_URL', phase: 'runtime' as const, source: { kind: 'deploymentFact' as const, fact: 'primaryUrl' as const } },
];

/** The lab's Domains cast (r3 `domains/routing`): a public address, a path, a redirect, protected and own-certificate ones. */
const SPECIMEN_DOMAINS = [
  { id: 'api', hostname: 'api.happier.dev', target: { service: 'web', containerPort: 3000 }, state: 'active' as const },
  { id: 'hooks', hostname: 'api.happier.dev', target: { service: 'worker', containerPort: 8081, path: '/webhooks/*' }, state: 'active' as const },
  { id: 'www', hostname: 'www.shop.happier.dev', target: { service: 'web', containerPort: 3000, redirectTo: 'shop.happier.dev' }, state: 'applying' as const },
  { id: 'admin', hostname: 'admin.happier.dev', target: { service: 'admin', containerPort: 8080 }, basicAuth: { username: 'ops' }, state: 'warning' as const },
  { id: 'status', hostname: 'status.happier.dev', target: { service: 'status', containerPort: 3001 }, tls: { kind: 'custom' as const }, state: 'failed' as const },
];

/**
 * `?tabs=` decides what the Domains, Checks & alerts, Backups and Previews reads answer: `populated` (default),
 * `empty`, `loading`, `error`, `denied`, `paged` (Domains continue to a second page), `notNeeded` (backups) and
 * `team` (a Team Environment) or `railway-domains` (Railway staging with its addresses, receipt and variables).
 * `railway-database` also links a database to the same Railway environment.
 */
function tabFixtures(tabs: string, environmentId: string, runtimeTargetLinkId: string) {
  const never = new Promise<never>(() => {});
  const domainItem = (domain: (typeof SPECIMEN_DOMAINS)[number]) => ({
    domain: { v: 1 as const, id: `domain-${domain.id}`, environmentId, targetLinkId: runtimeTargetLinkId, revision: 1, state: domain.state,
      contentArtifactId: `domain-content-${domain.id}`, contentHeaderVersion: 1, contentBodyVersion: 1,
      createdByAccountId: ACCOUNT, createdAtMs: SPECIMEN_NOW - 48 * HOUR, updatedAtMs: SPECIMEN_NOW - HOUR },
    title: domain.hostname,
    content: { hostname: domain.hostname, target: domain.target, healthCheck: { path: '/healthz', expectStatus: 200 },
      ...('basicAuth' in domain ? { basicAuth: domain.basicAuth } : {}), ...('tls' in domain ? { tls: domain.tls } : {}) },
  });
  const listDomains: NonNullable<DeploymentReadTransportV1['listDomains']> = async (_scope, _environmentId, query) => {
    if (tabs === 'loading') return never;
    if (tabs === 'error') return { ok: false, failure: { code: 'deployment_unavailable', retryable: true } };
    if (tabs === 'denied') return { ok: false, failure: { code: 'deployment_access_denied', retryable: false } };
    if (tabs === 'empty') return { ok: true, value: { items: [], nextCursor: null } };
    if (railwayTabs(tabs)) {
      const fixture = domainItem(SPECIMEN_DOMAINS[0]!);
      return { ok: true, value: { items: [
        { ...fixture, title: 'store-staging.up.railway.app', domain: { ...fixture.domain, provider: true },
          content: { hostname: 'store-staging.up.railway.app', target: { kind: 'provider' } } },
        { ...fixture, title: 'Provider-assigned address',
          domain: { ...fixture.domain, id: 'domain-assigned-pending', provider: true, state: 'pending' },
          content: { hostname: null, target: { kind: 'provider' } } },
        { ...fixture, title: 'staging.shop.example',
          domain: { ...fixture.domain, id: 'domain-custom-staging', provider: true, state: 'warning' },
          content: { hostname: 'staging.shop.example', target: { kind: 'provider' },
            providerObservation: { v: 1, hostname: 'staging.shop.example', state: 'pending',
              dns: [{ type: 'CNAME', name: 'staging.shop.example', value: 'store-staging.up.railway.app' }] } },
        },
      ], nextCursor: null } };
    }
    if (tabs === 'paged') {
      return query.cursor
        ? { ok: true, value: { items: SPECIMEN_DOMAINS.slice(3).map(domainItem), nextCursor: null } }
        : { ok: true, value: { items: SPECIMEN_DOMAINS.slice(0, 3).map(domainItem), nextCursor: 'page-two' } };
    }
    return { ok: true, value: { items: SPECIMEN_DOMAINS.map(domainItem), nextCursor: null } };
  };
  const observeEnvironmentHealth: NonNullable<DeploymentReadTransportV1['observeEnvironmentHealth']> = (_scope, detail, publish) => {
    const machineId = detail.runtimeTargetLink?.machines[0] ?? 'machine-a';
    const member = { machineId, installationId: 'installation-a' };
    const service = (name: string, state: 'up' | 'down') =>
      ({ serviceId: name, name, state, observedAt: SPECIMEN_NOW - 60_000, reason: null });
    if (tabs === 'loading') publish({ environmentId: detail.environment.id, status: 'loading', members: [] });
    else if (tabs === 'error' || tabs === 'denied') {
      publish({ environmentId: detail.environment.id, status: 'unavailable', members: [{ ...member, status: 'unavailable', services: [],
        failure: { code: tabs === 'denied' ? 'deployment_access_denied' : 'machine_unavailable', retryable: tabs !== 'denied' } }] });
    } else if (tabs === 'empty') publish({ environmentId: detail.environment.id, status: 'ready', members: [] });
    else {
      publish({ environmentId: detail.environment.id, status: 'ready', members: [{ ...member, status: 'ready',
        services: [service('web', tabs === 'failing' ? 'down' : 'up'), service('worker', 'up'), service('postgres', 'up')] }] });
    }
    return () => {};
  };
  const backup = tabs === 'empty' || tabs === 'loading' || tabs === 'error' || tabs === 'denied' ? undefined
    : tabs === 'notNeeded' ? { notNeeded: true as const }
      : {
        configRevision: 1, destinationRef: { pluginId: 'happier.backups-s3', localId: 'open' }, occurrenceId: 'backup-nightly',
        config: { endpoint: 'https://s3.eu-central-1.amazonaws.com', bucket: 'acme-backups', prefix: 'happier-api/', region: 'eu-central-1' },
        credentialBindings: [], ownership: { environmentId, prefix: 'staging/' },
        sources: [
          { kind: 'dump' as const, sourceId: 'db', service: 'postgres', consistency: 'logical' as const },
          { kind: 'volume' as const, sourceId: 'uploads', service: 'web', volume: 'uploads', consistency: 'stopDuringCopy' as const },
        ],
        retention: { kind: 'keep' as const, last: 7, daily: 14, weekly: 8 },
      };
  return { listDomains, observeEnvironmentHealth, backup, owner: tabs === 'team' ? { kind: 'team' as const, teamId: 'team-acme' } : null };
}

/**
 * `?preview=` makes Staging a preview template whose data can be a branch of its linked Neon database (lab
 * `previewdb/branch`): `unset` (Neon linked, no parent chosen yet), `linked` (previews branch from `main`) and
 * `enrollment` (the save lands but new pull requests are not picked up yet). Saves update this fixture in place; the
 * branch list answers as the Neon plugin's `branches-list-read` does.
 */
type SpecimenPreview = { kind: 'unset' | 'linked' | 'enrollment'; template: NonNullable<ReturnType<typeof createDeploymentEnvironmentDetailV1>['content']['previewTemplate']>; revision: number };
const NEON_LINK = 'target-neon';
const NEON_PARENT = { providerProjectId: 'polished-sun-41255823', branchId: 'br-main-a1b2c3d4' };
function createSpecimenPreview(kind: string | undefined): SpecimenPreview | null {
  if (kind !== 'unset' && kind !== 'linked' && kind !== 'enrollment') return null;
  return { kind, revision: 1, template: { v: 1, enabled: true, forkPreviews: 'off',
    repository: { kind: 'github', deployment: 'https://github.com', repository: 'acme/shop' },
    runtimeTargetLinkId: 'target-link', domain: { domainId: 'wildcard', templateSlug: 'shop', hostnamePattern: 'pr-{number}.preview.shop.dev' },
    bindingBlueprints: [], data: kind === 'unset' ? [] : [{ kind: 'managed', dataTargetLinkId: NEON_LINK, ownership: 'providerNative',
      parentBranchRef: NEON_PARENT }] } as SpecimenPreview['template'] };
}
function withSpecimenPreview<T extends ReturnType<typeof createDeploymentEnvironmentDetailV1>>(detail: T, preview: SpecimenPreview): T {
  const pluginId = 'happier.deploy.neon';
  const neon = createDeploymentTargetLinkHeaderV1({ id: NEON_LINK, environmentId: detail.environment.id, role: 'data', targetKind: 'neon',
    machines: [], members: [], source: { kind: 'plugin', contribution: { pluginId, localId: 'database' } } });
  return { ...detail, environment: { ...detail.environment, revision: preview.revision },
    content: { ...detail.content, previewTemplate: preview.template },
    targetLinks: [...detail.targetLinks, { targetLink: neon, content: {
      providerIdentity: { providerAccountId: 'org-acme', providerResourceId: NEON_PARENT.providerProjectId, providerEnvironment: NEON_PARENT.branchId },
      providerEnvironment: { kind: 'native', selection: { branchId: NEON_PARENT.branchId } }, credentialPrincipal: { kind: 'account', accountId: ACCOUNT,
        purpose: { consumer: { pluginId, localId: 'link' }, purpose: 'database.manage' },
        target: { kind: 'account', account: { service: { pluginId, localId: 'database' }, accountId: 'token' } } } } }] } as T;
}
function specimenPreviewActions(preview: SpecimenPreview) {
  return {
    updateEnvironment: async (environment: Readonly<{ id: string }>, patch: Readonly<{ previewTemplate?: SpecimenPreview['template'] | null }>) => {
      await pause();
      if (patch.previewTemplate) preview.template = patch.previewTemplate;
      preview.revision += 1;
      return { ok: true as const, environmentId: environment.id, revision: preview.revision,
        ...(preview.kind === 'enrollment' ? { previewEnrollment: { status: 'unavailable' as const, errorCode: 'source_unavailable' } } : {}) } as never;
    },
    inspectPlatformTarget: async () => {
      await pause();
      return { ok: true as const, value: { branches: [
        { providerProjectId: NEON_PARENT.providerProjectId, branchId: NEON_PARENT.branchId, name: 'main' },
        { providerProjectId: NEON_PARENT.providerProjectId, branchId: 'br-preview-pr-142', name: 'preview/pr-142' },
      ], nextCursor: null } };
    },
  };
}

function transportFor(
  state: string,
  receiptState: ReceiptState,
  machineId: string | null,
  cancellable: boolean | undefined,
  tabs: string,
  restore: string | undefined,
  preview: SpecimenPreview | null,
  telemetry?: string,
): DeploymentReadTransportV1 {
  const base = createDeploymentEnvironmentDetailV1();
  const railway = railwayTabs(tabs);
  const baseHeader = createDeploymentEnvironmentHeaderV1({
    updatedAtMs: SPECIMEN_NOW - 0.4 * HOUR,
  });
  // Addresses attach to the Environment's runtime link, so the serving one reads as serving, not Unattached.
  const fixtures = tabFixtures(tabs, baseHeader.id, base.targetLinks[0]!.targetLink.id);
  // `?telemetry=populated|offline`: the Environment keeps telemetry on a Machine of the Account (lab p7Flows-mark).
  const ownedHeader = fixtures.owner ? { ...baseHeader, owner: fixtures.owner } : baseHeader;
  // An Account without Machines keeps it on the specimen's fixture collector.
  const stagingHeader = telemetry ? { ...ownedHeader, telemetryMachineId: machineId ?? SPECIMEN_COLLECTOR_ID } : ownedHeader;
  // `?state=reader`: a reader sees everything but Deploy; `?state=plugin`: a target with no Deploy producer.
  const staging = createDeploymentEnvironmentDetailV1({
    content: { ...base.content, name: 'Staging', bindings: SPECIMEN_BINDINGS,
      ...(fixtures.backup ? { backup: fixtures.backup } : {}),
      // A collector Environment records every capability (lab p7Setup-waiting): Exceptions, App LLM calls and Metrics.
      ...(telemetry ? { telemetry: { metrics: true, appLlmCost: true, exceptions: true } } : {}) },
    // The one supplied availability fact (P40): one server, passing (down while a failed deploy left it so).
    healthAggregate: { v: 1, environmentId: stagingHeader.id, targetLinkId: stagingHeader.runtimeTargetLinkId!,
      protection: stagingHeader.protection, status: receiptState === 'failed' ? 'down' : 'up', n: 1,
      down: receiptState === 'failed' ? 1 : 0, degraded: 0, unknown: 0,
      members: [], affectedMachineIds: [], edgeUnreachable: false, authoritativeRecovery: false },
    environment: state === 'reader'
      ? { ...stagingHeader, capabilities: { ...stagingHeader.capabilities, role: 'reader', deploy: false, manage: false } }
      : stagingHeader,
    // While a deploy runs, the incumbent it replaces still serves.
    ...(receiptState === 'running' || receiptState === 'queued' ? { targetLinks: base.targetLinks.map((link) => ({
      ...link, targetLink: { ...link.targetLink, activeDeploymentId: 'deployment-b' } })) } : {}),
    ...(railway ? { targetLinks: base.targetLinks.map((link) => ({ targetLink: {
      ...link.targetLink, source: { kind: 'plugin' as const, contribution: RAILWAY_TARGET }, targetKind: 'railway', machines: [], members: [],
      activeDeploymentId: receiptState === 'running' || receiptState === 'queued' ? 'deployment-b' : 'deployment-a',
    }, content: RAILWAY_LINK })) } : state === 'plugin' ? { targetLinks: base.targetLinks.map((link) => ({ ...link, targetLink: {
      ...link.targetLink, source: { kind: 'plugin' as const, contribution: { pluginId: 'vercel', localId: 'project' } },
      targetKind: 'vercel', machines: [], members: [], machineId: 'machine-a', installationId: 'installation-a',
    } })) } : {}),
  });
  const stagingWithData = tabs === 'railway-database' ? {
    ...staging,
    targetLinks: [...staging.targetLinks, {
      targetLink: createDeploymentTargetLinkHeaderV1({ id: RAILWAY_DATA_LINK_ID, environmentId: staging.environment.id,
        role: 'data', targetKind: 'railway-postgresql', machines: [], members: [],
        source: { kind: 'plugin', contribution: RAILWAY_DATA_TARGET } }),
      content: {
        providerIdentity: { providerAccountId: RAILWAY_DATA_SELECTION.projectId, providerResourceId: RAILWAY_DATA_SELECTION.serviceId,
          providerEnvironment: RAILWAY_DATA_SELECTION.environmentId },
        providerEnvironment: { kind: 'native' as const, selection: RAILWAY_DATA_SELECTION },
        credentialPrincipal: { ...RAILWAY_LINK.credentialPrincipal,
          purpose: { consumer: { pluginId: RAILWAY_DATA_TARGET.pluginId, localId: 'postgresql-link' }, purpose: 'cloud-api' } },
        data: { engine: 'postgres', providerConsole: { label: 'Open in Railway',
          url: 'https://railway.com/project/shop-project/service/3f2a9c1e-7b4d-4e8a-9f10-2c6d5b8e1a47?environmentId=shop-staging' } },
        // What `managedDataLinkContent` stores from the link result's service name.
        preparedNative: { projectName: 'orders-db' },
      },
    }],
  } : staging;
  const production = createDeploymentEnvironmentDetailV1({
    content: { ...base.content, name: 'Production API' },
    environment: createDeploymentEnvironmentHeaderV1({
      id: 'environment-production',
      protection: 'production',
      updatedAtMs: SPECIMEN_NOW - 26 * HOUR,
    }),
    targetLinks: base.targetLinks.map((link) => ({
      ...link,
      targetLink: {
        ...link.targetLink,
        environmentId: 'environment-production',
      },
    })),
  });
  const receiptFixtures = [
    receiptFor('deployment-a', receiptState, 0.4, 'deploy', 'deployment-b', RECEIPT_TITLES[0]),
    receiptFor('deployment-b', 'succeeded', 26, 'deploy', 'deployment-d', RECEIPT_TITLES[1]),
    receiptFor('deployment-c', 'failed', 30, 'deploy', 'deployment-d', RECEIPT_TITLES[2]),
    receiptFor('deployment-d', 'succeeded', 52, 'rollback', null, undefined),
  ];
  const delivered = (receipt: (typeof receiptFixtures)[number]) => telemetry ? { ...receipt, content: { ...receipt.content,
    // The serving deploy delivered the collector's credential, so the tab reads the collector's status.
    machineResults: receipt.content.machineResults.map(result => ({ ...result,
      telemetryMachineId: stagingHeader.telemetryMachineId, telemetryTokenHash: '7'.repeat(64) })) } } : receipt;
  const receipts = onMachine(railway ? receiptFixtures.map(railwayReceipt) : receiptFixtures.map(delivered), machineId);
  const never = new Promise<never>(() => {});
  return {
    listDomains: fixtures.listDomains,
    observeEnvironmentHealth: (scope, detail, publish, options) =>
      fixtures.observeEnvironmentHealth(scope, onMachine(detail, machineId), publish, options),
    listEnvironments: async () =>
      state === 'loading'
        ? never
        : state === 'error'
          ? {
              ok: false,
              failure: { code: 'deployment_unavailable', retryable: true },
            }
          : {
              ok: true,
              value: {
                items:
                  state === 'empty'
                    ? []
                    : [
                        {
                          environment: onMachine(stagingWithData.environment, machineId),
                          title: 'Staging',
                          currentDeployment: {
                            ...receipts[0]!.deployment,
                            steps: receipts[0]!.content.steps,
                          },
                        },
                        {
                          environment: onMachine(production.environment, machineId),
                          title: 'Production API',
                          currentDeployment: receipts[2]!.deployment,
                        },
                      ],
                nextCursor: null,
              },
            },
    readEnvironment: async (_scope, environmentId) => ({
      ok: true,
      value: onMachine(environmentId === production.environment.id ? production
        : preview ? withSpecimenPreview(stagingWithData, preview) : stagingWithData, machineId),
    }),
    listHistory: async () => ({
      ok: true,
      value: {
        ok: true,
        items: receipts.map((receipt, index) => ({
          ...receipt.deployment,
          title: RECEIPT_TITLES[index],
        })),
        nextCursor: null,
      },
    }),
    readReceipt: async (_scope, _environmentId, deploymentId) => {
      const found = receipts.find((candidate) => candidate.deployment.id === deploymentId) ?? receipts[0]!;
      // `?restore=`: the serving deploy kept a pre-migration backup, so Settings → Backups offers to restore it.
      const receipt = restore && found === receipts[0] && found.content.ownServer
        ? { ...found, content: { ...found.content, ownServer: { ...found.content.ownServer,
          preMigrationBackup: specimenPreMigrationBackup(found.deployment.environmentId) } } } : found;
      return { ok: true, value: cancellable === undefined || receipt.deployment.id !== receipts[0]!.deployment.id
        ? receipt : { ...receipt, cancellable } };
    },
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 600));

const SPECIMEN_BACKUP_CONFIGURATION = (environmentId: string) => ({
  configRevision: 1, destinationRef: { pluginId: 'happier.backups-s3', localId: 'open' }, occurrenceId: 'backup-nightly', config: {},
  credentialBindings: [], ownership: { environmentId, prefix: 'staging/' },
  sources: [{ kind: 'dump' as const, sourceId: 'db', service: 'postgres', consistency: 'logical' as const }],
  retention: { kind: 'keep' as const, last: 7 },
});
const specimenManifest = (environmentId: string, snapshot: string, time: string) => ({
  schemaVersion: 1 as const, environmentId, sourceId: 'db', kind: 'dump' as const, configRevision: 1,
  repositoryId: 'a'.repeat(64), producerChecksumSha256: 'b'.repeat(64), totalBytesProcessed: 18_342_112, totalFilesProcessed: 1,
  snapshot: { snapshotId: snapshot.repeat(64), treeId: 'd'.repeat(64), hostname: 'staging-db', time, paths: ['dump'], tags: [] },
});
function specimenPreMigrationBackup(environmentId: string) {
  return { sourceFormat: 'postgresCustom' as const, target: { service: 'postgres', adapter: 'postgres-v1' as const, database: 'shop' },
    repository: { repository: 's3:https://backups.example.com/staging' }, configuration: SPECIMEN_BACKUP_CONFIGURATION(environmentId),
    source: specimenManifest(environmentId, 'c', new Date(SPECIMEN_NOW - 0.5 * HOUR).toISOString()) };
}

/**
 * The restore Action's answers, by `?restore=`: `restored` (default), `rolledBack`, `unknown`, `recovery`,
 * `stale` (the confirm finds the check no longer current) or `empty` (nothing to save before replacing).
 */
function specimenRestore(restore: string) {
  return async (input: import('@/components/projects/deployments/deploymentActions').DeploymentUiRestoreInput) => {
    await pause();
    if (input.mode === 'prepare') {
      const environmentId = input.environmentId;
      return { kind: 'prepared' as const, operationId: 'prepare-operation', evidence: { input: {}, native: {
        prepared: { kind: 'prepared', operationId: 'prepare-operation',
          source: specimenManifest(environmentId, 'c', new Date(SPECIMEN_NOW - 0.5 * HOUR).toISOString()),
          sourceFormat: 'postgresCustom', repository: { repository: 's3:https://backups.example.com/staging' },
          destination: { service: 'postgres', adapter: 'postgres-v1', database: 'shop', environmentId, revision: 1,
            stagingDatabase: 'shop_restore', recoveryDatabase: 'shop_recovery', databaseExists: true,
            hasMeaningfulData: restore !== 'empty', writerServices: ['web', 'worker'] },
          ...(restore === 'empty' ? {} : { safetyBackup: { kind: 'verified',
            manifests: [specimenManifest(environmentId, 'e', new Date(Date.now()).toISOString())] } }) },
        configuration: SPECIMEN_BACKUP_CONFIGURATION(environmentId),
      } } } as never;
    }
    if (restore === 'stale') throw new HappyError('restore_prepare_required', false, { code: 'restore_prepare_required' });
    const kind = restore === 'rolledBack' ? 'rolledBack' : restore === 'unknown' ? 'outcome_unknown'
      : restore === 'recovery' ? 'recoveryRequired' : 'restored';
    return { kind, verified: kind === 'restored', nextAction: 'none', evidence: {} } as never;
  };
}

/**
 * The Action owner's answers, by `?deploy=`: `unsupported` (the own-server producer cannot build), `denied`,
 * `offline`, `started` (accepted, the rail shows it) or `conflict`. A held review is not drawn here: it opens
 * the real approval page, which only a real request has.
 */
function specimenActions(deploy: string, restore: string | undefined, tabs: string | undefined) {
  const railway = railwayTabs(tabs);
  const refusal = (error: string) => ({ ok: false as const, error } as never);
  const unsupported = async () => {
    await pause();
    throw new HappyError('unsupported', false, { code: 'unsupported' });
  };
  return {
    restore: restore ? specimenRestore(restore) : unsupported,
    restart: unsupported,
    link: unsupported,
    inspectPlatformTarget: async (_actionId: string, input: Record<string, unknown>) => {
      if (tabs !== 'railway-database' || input.targetLinkId !== RAILWAY_DATA_LINK_ID) return unsupported();
      await pause();
      return { ok: true as const, value: { reference: '${{Orders.DATABASE_URL}}' } };
    },
    addDomain: unsupported,
    removeDomain: unsupported,
    verifyDomain: unsupported,
    setController: unsupported,
    updateEnvironment: unsupported,
    rollback: async () => {
      await pause();
      return refusal('deployment_conflict');
    },
    // The receipt moved on before the press reached it: the server's revision check refuses.
    cancel: async () => {
      await pause();
      return refusal('deployment_conflict');
    },
    // The step's masked pages, as `deployments.logs.read` serves them by ref.
    readLogs: async (input: Readonly<{ ref?: string; tail?: true; cursor?: { sourceRevision: string; token: string } }>) => {
      await pause();
      return readStepLog(railway && !input.ref ? { ...input, ref: 'railwayBuild' } : input) as never;
    },
    deploy: async () => {
      await pause();
      if (deploy === 'unsupported') throw new HappyError('unsupported', false, { code: 'unsupported' });
      if (deploy === 'started') return { ok: true as const, kind: 'pending' as const } as never;
      return refusal(deploy === 'denied' ? 'deployment_access_denied'
        : deploy === 'offline' ? 'machine_unavailable' : 'deployment_conflict');
    },
    prepareCreate: async () => {
      await pause();
      throw new HappyError('deployment_conflict', false, { code: 'deployment_conflict' });
    },
    // Variables Save answers as a held review would not: the fixture accepts, so the page shows the saved state.
    setBindings: async (input: Readonly<{ environmentId: string; expectedRevision: number }>) => {
      await pause();
      return { ok: true as const, environmentId: input.environmentId, revision: input.expectedRevision + 1 } as never;
    },
    // Delete / Unlink reach the review; the fixture refuses, so the sheet shows its refusal line.
    deleteEnvironment: async () => {
      await pause();
      return refusal('deployment_teardown_required');
    },
    unlink: async () => {
      await pause();
      return refusal('deployment_teardown_required');
    },
    teardown: async () => {
      await pause();
      return refusal('deployment_conflict');
    },
  };
}

/**
 * `?removal=` opens the Delete/Unlink review over one target the way the Environment page builds it: a resource
 * Happier created (starts on Delete), a linked one (starts on Unlink), a provider that declares no delete, a Machine.
 */
const SPECIMEN_REMOVALS: Readonly<Record<string, Omit<DeploymentDispositionSheetInput, 'run' | 'onApproval' | 'onDone'>>> = {
  created: { subject: { kind: 'target', targetLinkId: 'link-vercel' }, name: 'Production', machine: null, provider: 'Vercel',
    running: true, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'acme-web', consequence: 'Delete this Vercel project and its deployments?', defaultChoice: 'delete' } },
  linked: { subject: { kind: 'target', targetLinkId: 'link-workers' }, name: 'Production', machine: null, provider: 'Cloudflare Workers',
    running: true, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'acme-api', consequence: 'Delete this Cloudflare Worker or Preview and its associated resources?',
      defaultChoice: 'unlink' } },
  environment: { subject: { kind: 'environment' }, name: 'Staging', machine: null, provider: 'Vercel',
    running: true, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'acme-web-staging', consequence: 'Delete this Vercel project and its deployments?', defaultChoice: 'delete' } },
  nodelete: { subject: { kind: 'target', targetLinkId: 'link-pages' }, name: 'Docs', machine: null, provider: 'Cloudflare Pages',
    running: true, hasRetainedAssociations: true, canRemove: false,
    providerResource: { name: 'acme-docs', consequence: null, defaultChoice: 'unlink' } },
  railway: { subject: { kind: 'target', targetLinkId: 'link-railway' }, name: 'Staging', machine: null, provider: 'Railway',
    running: true, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'backend', consequence: 'Delete this Railway service and its deployments?',
      defaultChoice: 'unlink' } },
  // A managed database project, from the Database page: the provider's own delete words, Environment kept.
  'data-created': { subject: { kind: 'target', targetLinkId: 'link-neon' }, name: 'Production', machine: null, provider: 'Neon',
    running: false, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'shop-orders', consequence: 'Delete this Neon project and all of its data?', defaultChoice: 'delete' , role: 'data' } },
  'data-linked': { subject: { kind: 'target', targetLinkId: 'link-supabase' }, name: 'Production', machine: null, provider: 'Supabase',
    running: false, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'acme-auth', consequence: 'Delete the recorded Supabase project and all of its data',
      defaultChoice: 'unlink' , role: 'data' } },
  'railway-database': { subject: { kind: 'target', targetLinkId: RAILWAY_DATA_LINK_ID }, name: 'Staging', machine: null,
    provider: 'Railway PostgreSQL', running: false, hasRetainedAssociations: true, canRemove: true,
    providerResource: { name: 'orders-db', consequence: 'Delete this Railway database and its data?', defaultChoice: 'unlink', role: 'data' } },
  machine: { subject: { kind: 'target', targetLinkId: 'link-machine' }, name: 'Production', machine: 'vps-fra-1',
    running: true, services: ['web', 'worker', 'postgres'], hasRetainedAssociations: true, canRemove: true },
};

function useSpecimenRemoval(removal: string | undefined) {
  React.useEffect(() => {
    const input = removal ? SPECIMEN_REMOVALS[removal] : undefined;
    if (!input) return;
    showDeploymentDispositionSheet({ ...input, onApproval: () => {}, onDone: () => {},
      run: async () => { await pause(); return { kind: 'refused', reason: 'other', code: 'deployment_conflict' }; } });
  }, [removal]);
}

function RailwayProjectPickerSpecimen() {
  const [input, setInput] = React.useState<Record<string, unknown>>({ projectId: 'storefront' });
  return <View style={deploymentSheetStyles.body}>
    <ActionInputFields
      fields={[{ path: 'projectId', title: 'Railway project', widget: 'select', visible: true, required: true, disabled: false }]}
      input={input}
      editable
      resolveFieldTestID={() => 'railway-project-picker-specimen'}
      resolveFieldOptions={() => [
        { value: 'storefront', label: 'Storefront' },
        { value: 'orders', label: 'Order processing' },
        { value: 'catalog', label: 'Product catalog' },
        { value: 'support', label: 'Customer support' },
      ]}
      resolveChoiceAction={() => ({ label: 'Create Railway project', run: () => {} })}
      onPatch={setInput}
    />
  </View>;
}

const EMPTY_SERVICE_FIELD = { path: 'providerEnvironment', title: 'Railway service', widget: 'select', visible: true, required: true,
  disabled: false } as const;
const NO_SERVICES = Object.assign(() => [], { state: () => ({ status: 'ready' as const, options: [] }) });

/** The Existing path on a project with no services yet: the platform sheet's Service row, settled empty, leads to New. */
function RailwayServiceEmptySpecimen() {
  return <ListPresentationProvider value="page" pageInsets="contained"><View style={deploymentSheetStyles.body}>
    <ItemGroup>
      <Item title={EMPTY_SERVICE_FIELD.title} showChevron={false} accessoryLayout="adaptive" rightElement={
        <ActionInputFields fields={[EMPTY_SERVICE_FIELD]} input={{}} editable frame="none"
          resolveFieldTestID={() => 'railway-service-empty-specimen'} resolveFieldOptions={NO_SERVICES}
          resolveOptionsEmptyAction={() => ({ label: t('projects.deployments.platformLink.createNew'), onPress: () => {} })}
          onPatch={() => {}} />
      } />
    </ItemGroup>
  </View></ListPresentationProvider>;
}

const EMPTY_SOURCE_FIELD = { path: 'source', title: 'Source', widget: 'select', visible: true, required: true, disabled: false } as const;

/** A framed Action form field (label above) whose choice is settled empty with a next step, as a plugin's declared emptyAction draws. */
function EmptyChoiceFormSpecimen() {
  return <ListPresentationProvider value="page" pageInsets="contained"><View style={deploymentSheetStyles.body}>
    <ActionInputFields fields={[EMPTY_SOURCE_FIELD]} input={{}} editable resolveFieldOptions={NO_SERVICES}
      resolveFieldTestID={() => 'empty-choice-form-specimen'}
      resolveOptionsEmptyAction={() => ({ label: 'Connect GitHub', onPress: () => {} })} onPatch={() => {}} />
  </View></ListPresentationProvider>;
}

/** A Home/Account that stays current for the specimen's lifetime, so the Variables draft is editable. */
const SPECIMEN_LIFETIME = {
  scope: { serverId: 'home', accountId: ACCOUNT },
  isCurrent: () => true,
  onRetire: () => ({ dispose: () => {} }),
} as const;

export function DeploymentsSpecimen(
  props: Readonly<{ state: string; receipt: string; deploy?: string; machine?: string; cancellable?: string; tabs?: string;
    restore?: string; preview?: string; removal?: string; telemetry?: string }>,
) {
  useSpecimenRemoval(props.removal);
  React.useEffect(() => {
    if (props.state === 'railway-service-empty') {
      showDeploymentSheet({ component: RailwayServiceEmptySpecimen, props: {}, title: 'Deploy Orders API to a platform',
        testID: 'project-deployments.railway-service-empty.specimen' });
    }
    if (props.state === 'empty-choice-form') {
      showDeploymentSheet({ component: EmptyChoiceFormSpecimen, props: {}, title: 'Watch issues',
        testID: 'project-deployments.empty-choice-form.specimen' });
    }
    if (props.state !== 'railway-project-picker') return;
    showDeploymentSheet({ component: RailwayProjectPickerSpecimen, props: {}, title: 'Choose a Railway project',
      testID: 'project-deployments.railway-project-picker.specimen' });
  }, [props.state]);
  // A real Machine of the signed-in Account: `?machine=` names one, else the longest name (the hardest wrap).
  const wanted = props.machine?.toLowerCase() ?? null;
  const machineId = useAllMachines((machines) => {
    const named = machines.map((machine) => ({ id: machine.id, name: machine.metadata?.displayName ?? machine.metadata?.host ?? '' }));
    const match = wanted ? named.find((machine) => machine.name.toLowerCase().includes(wanted)) : null;
    return (match ?? [...named].sort((a, b) => b.name.length - a.name.length)[0])?.id ?? null;
  });
  const preview = React.useMemo(() => createSpecimenPreview(props.preview), [props.preview]);
  const actions = React.useMemo(() => ({ ...specimenActions(props.deploy ?? 'unsupported', props.restore, props.tabs),
    ...(preview ? specimenPreviewActions(preview) : {}) }), [props.deploy, props.restore, props.tabs, preview]);
  // Preview and Railway database specimens use the signed-in Account's installed deployment-target declarations; the
  // other Railway tabs keep the specimen's own current Account, like every sibling, so the fixture source stays theirs.
  // The database tab names its platform and offers Unlink or delete from the installed Railway declarations.
  const declarations = preview || props.tabs === 'railway-database';
  const { binding } = useServerCredentialAccountScopeBinding(declarations ? getActiveServerId() : null);
  const cancellable = props.cancellable === 'true' ? true : props.cancellable === 'false' ? false : undefined;
  const receiptState = (
    [
      'queued',
      'running',
      'running_unverified',
      'succeeded',
      'failed',
      'cancelled',
      'outcome_unknown',
    ].includes(props.receipt)
      ? props.receipt
      : 'succeeded'
  ) as ReceiptState;
  const controller = React.useMemo(
    () =>
      createDeploymentReadControllerV1({
        scope: {
          serverId: 'home',
          accountId: ACCOUNT,
          projectSourceId: 'source-app',
        },
        transport: transportFor(props.state, receiptState, machineId, cancellable, props.tabs ?? 'populated', props.restore, preview,
          props.telemetry),
      }),
    [props.state, receiptState, machineId, cancellable, props.tabs, props.restore, preview, props.telemetry],
  );
  React.useEffect(() => () => controller.retire(), [controller]);
  // An Account without Machines gets one fixture collector in this Home's store, online or (`?telemetry=offline`) not
  // answering, so the tab's Machine name and presence come from the presence owner as on a real page.
  React.useEffect(() => {
    if (!props.telemetry || machineId) return;
    const answering = props.telemetry !== 'offline';
    void publishMachineInventoryForTest({ serverId: 'home', accountId: ACCOUNT }, [createMachineFixture({
      id: SPECIMEN_COLLECTOR_ID, active: answering, activeAt: answering ? Date.now() : SPECIMEN_NOW - 26 * HOUR,
      metadata: { ...createMachineMetadataFixture(), host: 'hetzner-fsn1', displayName: 'hetzner-fsn1' },
    })]);
  }, [props.telemetry, machineId]);
  const telemetryInvoke = React.useMemo(() => props.telemetry
    ? createTelemetryCaptureFixtureInvoke(props.telemetry === 'offline' || props.telemetry === 'waiting' ? props.telemetry : 'populated')
    : null, [props.telemetry]);
  if (props.state === 'prepare-recognized' || props.state === 'prepare-unknown') {
    const known = props.state === 'prepare-recognized';
    return <ListPresentationProvider value="page" pageInsets="contained">
      <DeploymentPreparationRecognized read={{ status: 'ready', facts: {
        applications: [{ file: 'package.json', framework: known ? 'next' : null,
          runtime: known ? { name: 'node', version: '22' } : null, port: known ? 3000 : null, build: null, start: null }],
        rootFiles: { dockerfile: known ? 'present' : 'unknown', compose: known ? 'present' : 'unknown' },
        ...(known ? { healthPath: '/healthz', environmentExample: 'absent' as const } : {}), partial: !known,
      } }} />
    </ListPresentationProvider>;
  }
  const view = (
    <ProjectDeploymentsView
      controller={controller}
      actions={actions}
      demand={SHOWN}
      accountId={ACCOUNT}
      serverId="home"
      lifetime={props.state === 'reader' ? null : declarations ? binding : SPECIMEN_LIFETIME as never}
      sourceId="source-app"
    />
  );
  // The collector's answers stand in for the Action front door; the tab's own reads and views are the real ones.
  return telemetryInvoke
    ? <TelemetryCaptureFixtureProvider invoke={telemetryInvoke}>{view}</TelemetryCaptureFixtureProvider>
    : view;
}
