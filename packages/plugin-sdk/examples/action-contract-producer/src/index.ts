import {
  definePlugin,
} from '@happier-dev/plugin-sdk';
import type { TargetedContributionPointRef } from '@happier-dev/plugin-sdk/contributions';
import {
  PUBLIC_TOOLCHAIN_COMPATIBILITY_V1,
  type BrowserActionContributionInput,
  type BrowserTargetContributionInput,
} from '@happier-dev/plugin-sdk/browser';
import type { PluginRequestInterceptor } from '@happier-dev/plugin-sdk/http';
import type { NotificationSender } from '@happier-dev/plugin-sdk/notifications';
import type { SecretStatus } from '@happier-dev/plugin-sdk/secrets';
import { QualifiedConnectedAccountRefSchema } from '@happier-dev/plugin-sdk/connected-accounts';
import { areProviderContributionKeysEqualV1 } from '@happier-dev/plugin-sdk/providers';
import type { ActionApprovalRequestCreatedResult } from '@happier-dev/plugin-sdk/actions';
import { TriageSourcesContributionPointV1 } from '@happier-dev/triage-protocol/v1';

/**
 * The webhook credential is plugin-owned, so it is declared as a plugin secret
 * and only ever reached through the host SecretsService. It is never written to
 * settings, plugin storage, an Action result, or a log line.
 */
const DOCUMENT_REVIEW_WEBHOOK_TOKEN = 'document-review-webhook-token';
const DOCUMENT_REVIEW_PLUGIN_ID = 'examples.action-contract-producer';
const DOCUMENT_REVIEW_SERVICES_EVENT = 'document-review-services-inspected';
const DOCUMENT_REVIEW_SERVICE_RESOURCE = 'document-review-service-guide';
const DOCUMENT_REVIEW_SERVICE_DIRECTORY = {
  root: 'pluginData',
  relativePath: 'service-check',
} as const;
const DOCUMENT_REVIEW_SERVICE_FILE = {
  root: 'pluginData',
  relativePath: 'service-check/document-review-services.txt',
} as const;
const DOCUMENT_REVIEW_SERVICE_FILE_CONTENTS = 'Document review service inspection.';
const DOCUMENT_REVIEW_SERVICE_RESOURCE_BYTES = new TextEncoder().encode(
  'Document review service guide.',
);
const documentReviewServicesEventRef = {
  pluginId: DOCUMENT_REVIEW_PLUGIN_ID,
  localId: DOCUMENT_REVIEW_SERVICES_EVENT,
} as const;

/**
 * The rotation result reuses the service's own state vocabulary instead of
 * respelling it, and carries a revision so a caller can reject a stale update.
 */
type WebhookTokenRotation = Readonly<{
  state: SecretStatus['state'];
  revision: string;
}>;

type DocumentReviewerContribution = Readonly<{
  contributor: Readonly<{
    pluginId: string;
    contributionId: string;
  }>;
  descriptor?: Readonly<{
    displayName?: string;
  }>;
}>;

let documentReviewersPoint: TargetedContributionPointRef<DocumentReviewerContribution>;

function readRotationToken(input: unknown): string | null {
  if (input === null || typeof input !== 'object') return null;
  const token = (input as Readonly<{ token?: unknown }>).token;
  return typeof token === 'string' && token.length > 0 ? token : null;
}

type ForwardToSessionRunInput = Readonly<{
  sessionId: string;
  runId: string;
  text: string;
  idempotencyKey: string;
  attachmentEntryId?: string;
}>;

type TeamCredentialParityInput = Readonly<{
  teamId: string;
  resourceId: string;
}>;

function readTeamCredentialParityInput(input: unknown): TeamCredentialParityInput {
  if (input === null || typeof input !== 'object') {
    throw new Error('team_credential_parity_input_required');
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (typeof value.teamId !== 'string' || value.teamId.length === 0) {
    throw new Error('team_credential_parity_teamId_required');
  }
  if (typeof value.resourceId !== 'string' || value.resourceId.length === 0) {
    throw new Error('team_credential_parity_resourceId_required');
  }
  return { teamId: value.teamId, resourceId: value.resourceId };
}

type SharedSecretUpdateInput = Readonly<{
  resourceId: string;
  expectedRevision: number;
  displayName: string;
  kind: 'apiKey' | 'token' | 'password' | 'other';
  value: string;
}>;

function readSharedSecretUpdateInput(input: unknown): SharedSecretUpdateInput {
  if (input === null || typeof input !== 'object') {
    throw new Error('shared_secret_update_input_required');
  }
  const value = input as Readonly<Record<string, unknown>>;
  if (typeof value.resourceId !== 'string' || value.resourceId.length === 0) {
    throw new Error('shared_secret_update_resourceId_required');
  }
  if (typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 0) {
    throw new Error('shared_secret_update_expectedRevision_invalid');
  }
  if (typeof value.displayName !== 'string' || value.displayName.length === 0) {
    throw new Error('shared_secret_update_displayName_required');
  }
  if (value.kind !== 'apiKey' && value.kind !== 'token' && value.kind !== 'password' && value.kind !== 'other') {
    throw new Error('shared_secret_update_kind_invalid');
  }
  if (typeof value.value !== 'string' || value.value.length === 0) {
    throw new Error('shared_secret_update_value_required');
  }
  return {
    resourceId: value.resourceId,
    expectedRevision: value.expectedRevision,
    displayName: value.displayName,
    kind: value.kind,
    value: value.value,
  };
}

function isPendingApproval(value: unknown): value is ActionApprovalRequestCreatedResult {
  return value !== null
    && typeof value === 'object'
    && (value as Readonly<{ kind?: unknown }>).kind === 'approval_request_created';
}

function readForwardToSessionRunInput(input: unknown): ForwardToSessionRunInput {
  if (input === null || typeof input !== 'object') {
    throw new Error('forward_session_run_input_required');
  }
  const value = input as Readonly<Record<string, unknown>>;
  const sessionId = value['sessionId'];
  const runId = value['runId'];
  const text = value['text'];
  const idempotencyKey = value['idempotencyKey'];
  const attachmentEntryId = value['attachmentEntryId'];
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new Error('forward_session_run_sessionId_required');
  }
  if (typeof runId !== 'string' || runId.length === 0) {
    throw new Error('forward_session_run_runId_required');
  }
  if (typeof text !== 'string' || text.length === 0) {
    throw new Error('forward_session_run_text_required');
  }
  if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
    throw new Error('forward_session_run_idempotencyKey_required');
  }
  if (
    attachmentEntryId !== undefined &&
    (typeof attachmentEntryId !== 'string' || attachmentEntryId.length === 0)
  ) {
    throw new Error('forward_session_run_attachmentEntryId_invalid');
  }
  return attachmentEntryId === undefined
    ? { sessionId, runId, text, idempotencyKey }
    : { sessionId, runId, text, idempotencyKey, attachmentEntryId };
}

const documentReviewBrowserTarget = {
  title: 'Document review',
  url: 'https://review.example.test/documents',
  profile: 'session',
} satisfies Omit<BrowserTargetContributionInput, 'id'>;

const openDocumentReviewBrowserAction = {
  title: 'Open document review',
  action: 'open-document-review',
  target: 'document-review',
  placement: 'toolbar',
} satisfies Omit<BrowserActionContributionInput, 'id'>;

const documentReviewRequestPolicy: PluginRequestInterceptor = async (request) => ({
  decision: 'continue',
  request,
});

const documentReviewNotificationSender: NotificationSender = async (request) => ({
  deliveryId: request.deliveryId,
  channelId: request.channelId,
  status: 'accepted',
  evidence: 'provider',
});

const plugin = definePlugin({
  id: DOCUMENT_REVIEW_PLUGIN_ID,
  version: '0.1.0',
  displayName: 'Document Reviewer Target',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  hostAccess: {
    required: [
      {
        id: 'document-review-service-files',
        capability: 'filesystem',
        reason: 'Inspect and remove the plugin-local document review service check.',
        scope: {
          locations: [{ root: 'pluginData', pathPrefix: 'service-check' }],
          access: ['read', 'write', 'delete'],
        },
      },
      {
        id: 'document-review-session-send',
        capability: 'sessions',
        reason: 'Send trusted document-review messages to selected Sessions and their retained execution runs.',
        // `forward-to-session-run` resolves an exact public Session handle and
        // then sends through it. Declare both public operations so the same
        // installed external plugin works without privileged host access.
        scope: { access: ['read', 'write'] },
      },
    ],
  },
  actions: {
    'inspect-document-review-services': {
      title: 'Inspect document review services',
      description: 'Checks the declared document review services without retaining plugin-local data.',
      tool: { name: 'document_review_inspect_services' },
      toolExposure: { agent: 'direct', mcp: 'direct' },
      cli: { path: ['document-review', 'inspect-services'] },
      surfaces: ['cli', 'mcp', 'agent', 'plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesLocal',
      confirmation: {
        title: 'Inspect document review services?',
        body: 'This briefly writes and removes a plugin-local document review service-check file.',
        confirmLabel: 'Inspect services',
      },
      hostAccess: ['document-review-service-files'],
      run: async (_input, context) => {
        const eventSubscription = context.services.events.plugin.subscribe(
          documentReviewServicesEventRef,
          async () => undefined,
        );
        const resourceDescriptor = context.services.resources.describe(DOCUMENT_REVIEW_SERVICE_RESOURCE);
        const resource = await context.services.resources.read(DOCUMENT_REVIEW_SERVICE_RESOURCE, {
          signal: context.signal,
        });
        const resourceWatch = await context.services.resources.watch(
          DOCUMENT_REVIEW_SERVICE_RESOURCE,
          () => undefined,
        );
        let fileWritten = false;
        try {
          const event = await context.services.events.plugin.emit(
            DOCUMENT_REVIEW_SERVICES_EVENT,
            { source: 'document-review-service-inspection' },
            { signal: context.signal },
          );
          await context.services.fs.writeFile(
            DOCUMENT_REVIEW_SERVICE_FILE,
            new TextEncoder().encode(DOCUMENT_REVIEW_SERVICE_FILE_CONTENTS),
            { signal: context.signal },
          );
          fileWritten = true;
          const file = await context.services.fs.readFile(DOCUMENT_REVIEW_SERVICE_FILE, {
            signal: context.signal,
          });
          const fileStat = await context.services.fs.stat(DOCUMENT_REVIEW_SERVICE_FILE, {
            signal: context.signal,
          });
          const directory = await context.services.fs.list(DOCUMENT_REVIEW_SERVICE_DIRECTORY, {
            signal: context.signal,
          });
          const providers = await context.services.providers.connections.describe({}, {
            signal: context.signal,
          });
          return {
            event: {
              sequence: event.sequence,
              subscriberCount: event.subscriberCount,
            },
            filesystem: {
              kind: fileStat.kind,
              size: file.byteLength,
              entries: directory.items.map((item) => item.name),
              removed: true,
            },
            providers: { status: providers.status },
            resource: {
              kind: resourceDescriptor.kind,
              contentType: resource.contentType,
              digest: resource.digest,
              size: resourceDescriptor.size,
              bytes: resource.bytes.byteLength,
            },
          };
        } finally {
          try {
            if (fileWritten) {
              await context.services.fs.remove(DOCUMENT_REVIEW_SERVICE_FILE, {
                signal: context.signal,
              });
            }
          } finally {
            resourceWatch.dispose();
            eventSubscription.dispose();
          }
        }
      },
    },
    'list-document-reviewers': {
      title: 'List admitted document reviewers',
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      run: async (_input, context) => {
        const observation = context.services.targetedContributions.observeForSelf(
          documentReviewersPoint,
          { onInvalidated: () => {} },
        );
        try {
          const snapshot = await observation.readCurrent({ signal: context.signal });
          return {
            occurrenceId: snapshot.occurrenceId,
            sourceCustody: snapshot.sourceCustody,
            contributors: snapshot.contributions.map((contribution) => ({
              pluginId: contribution.contributor.pluginId,
              contributionId: contribution.contributor.contributionId,
              displayName: contribution.descriptor?.displayName ?? contribution.contributor.contributionId,
            })),
          };
        } finally {
          observation.dispose();
        }
      },
    },
    'inspect-team-credential-parity': {
      title: 'Inspect Team credential parity',
      description: 'Lists Lane 10 Team credential resources and shared Saved Secrets through the same host Actions and Provider/Connected Account services used by built-ins, without disclosing material.',
      surfaces: ['cli', 'mcp', 'agent', 'plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: {
        type: 'object',
        properties: {
          teamId: { type: 'string', minLength: 1 },
          resourceId: { type: 'string', minLength: 1 },
        },
        required: ['teamId', 'resourceId'],
        additionalProperties: false,
      },
      run: async (input, context) => {
        const { teamId, resourceId } = readTeamCredentialParityInput(input);
        // Same Lane 10 Actions used by built-in Team Settings and pickers, invoked
        // through the canonical contributed-Action dispatcher. No second registry,
        // catalog, broker, runtime, or privileged packed path. All used families
        // (actions, providers, connectedAccounts, secrets, resources) are
        // `available` in capability-matrix.json; browser/clipboard/externalLinks
        // remain `deferred` and are not used here.
        const credentialListing = await context.services.actions.execute(
          'teams.credentials.list',
          { teamId },
          { signal: context.signal },
        );
        if (isPendingApproval(credentialListing)) return credentialListing;
        const sourceCatalog = await context.services.actions.execute(
          'teams.credentials.sources.list',
          { teamId },
          { signal: context.signal },
        );
        if (isPendingApproval(sourceCatalog)) return sourceCatalog;
        // The saved-resource test is an external effect and may incur Provider
        // usage. The shared Action owner decides whether it runs now or returns
        // a durable approval request; this plugin never bypasses that decision.
        const resourceTest = await context.services.actions.execute(
          'teams.credentials.test',
          { teamId, resourceId },
          { signal: context.signal },
        );
        if (isPendingApproval(resourceTest)) return resourceTest;
        // Same Shared Saved Secret list used by built-ins. Raw shared materialization
        // remains host-owned (SavedSecretMaterializerV1 plus scoped plugin secret
        // settings/raw credential materializer per Lane 10.08); the public SDK exposes
        // no raw shared-material getter by design, so this parity proof lists with
        // materialStatus and never discloses bytes.
        const sharedListing = await context.services.actions.execute(
          'secrets.shared.list',
          {},
          { signal: context.signal },
        );
        if (isPendingApproval(sharedListing)) return sharedListing;
        // Same Provider listing used by built-ins, through the public ProvidersService.
        const providerListing = await context.services.providers.connections.describe(
          {},
          { signal: context.signal },
        );
        // Same Connected Account listing used by built-ins, through the public
        // ConnectedAccountsService. Production admission requires the same declared
        // purpose and host binding as built-ins; an undeclared purpose surfaces typed
        // unavailability from the host, never a personal fallback.
        const connectedListing = await context.services.connectedAccounts.listAccounts(
          { purpose: 'document-review-api', limit: 50 },
          { signal: context.signal },
        );
        // Prove the same contribution-identity vocabulary as built-ins via the public
        // SDK helpers, not hand-rolled comparison or a host-internal import.
        for (const entry of connectedListing.accounts) {
          QualifiedConnectedAccountRefSchema.parse(entry.account);
        }
        const providerIdentityMatch =
          areProviderContributionKeysEqualV1('openai', 'openai') &&
          !areProviderContributionKeysEqualV1('openai', 'anthropic');
        // Recipient-safe projection only: no custodian, broker, audience, revision,
        // bearer, signed capability, prompt, response, or secret bytes.
        if (!('resources' in credentialListing) || !Array.isArray(credentialListing.resources)) {
          throw new Error('team_credential_parity_listing_unavailable');
        }
        if (!('resources' in sharedListing) || !Array.isArray(sharedListing.resources)) {
          throw new Error('shared_secret_parity_listing_unavailable');
        }
        const resources = credentialListing.resources;
        const shared = sharedListing.resources;
        return {
          teamId,
          credentialResources: resources.map((resource) => ({
            id: resource.id,
            displayName: resource.displayName,
            sourceKind: resource.source?.kind ?? null,
            serviceIdentity:
              resource.source?.kind === 'connected_account'
                ? resource.source.target.account.service
                : resource.source?.kind === 'connected_pool'
                  ? resource.source.target.service
                  : null,
            providerIdentity:
              resource.sourcePresentation?.kind === 'provider'
                ? resource.sourcePresentation.provider.identity
                : null,
            readinessKind: resource.readiness?.kind ?? null,
          })),
          sharedSecrets: shared.flatMap((entry) => 'ref' in entry
            ? [{
                ref: entry.ref,
                name: entry.name,
                materialStatus: entry.materialStatus,
                canUse: entry.capabilities.use,
              }]
            : []),
          sourceCatalog: {
            supportedKinds: sourceCatalog.supportedKinds,
            candidates: sourceCatalog.candidates.map((candidate) => ({
              id: candidate.candidateId,
              label: candidate.label,
              sourceKind: candidate.source.kind,
            })),
          },
          resourceTest,
          providerStatus: providerListing.status,
          connectedAccounts: {
            status: connectedListing.status,
            accounts: connectedListing.accounts.map((entry) => ({
              displayName: entry.displayName,
              state: entry.state,
            })),
          },
          providerIdentityMatch,
        };
      },
    },
    'update-shared-secret': {
      title: 'Update a shared Saved Secret',
      description: 'Updates one shared Saved Secret through the canonical Action, preserving approval deferral and typed host failures without returning secret material.',
      surfaces: ['cli', 'plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'writesRemote',
      inputHints: { fields: [{ path: 'value', title: 'Secret value', widget: 'secret' }] },
      confirmation: {
        title: 'Update this shared Saved Secret?',
        body: 'This replaces the selected shared Saved Secret for its current recipients.',
        confirmLabel: 'Update secret',
      },
      inputSchema: {
        type: 'object',
        properties: {
          resourceId: { type: 'string', minLength: 1 },
          expectedRevision: { type: 'number', minimum: 0 },
          displayName: { type: 'string', minLength: 1 },
          kind: { type: 'string', enum: ['apiKey', 'token', 'password', 'other'] },
          value: { type: 'string', minLength: 1 },
        },
        required: ['resourceId', 'expectedRevision', 'displayName', 'kind', 'value'],
        additionalProperties: false,
      },
      run: async (input, context) => {
        const request = readSharedSecretUpdateInput(input);
        return context.services.actions.execute('secrets.shared.update', {
          resourceId: request.resourceId,
          expectedRevision: request.expectedRevision,
          displayName: request.displayName,
          kind: request.kind,
          storedContent: {
            t: 'plain',
            v: {
              v: 1,
              name: request.displayName,
              kind: request.kind,
              value: request.value,
            },
          },
        }, { signal: context.signal });
      },
    },
    'open-document-review': {
      title: 'Open document review',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      run: async () => null,
    },
    'send-document-review-ready': {
      title: 'Send document review notification',
      tool: {
        name: 'document_review_notify_ready',
        description: 'Delivers a review-ready notification through the configured channel.',
      },
      cli: { path: ['document-review', 'notify-ready'] },
      toolExposure: { agent: 'direct', mcp: 'direct' },
      surfaces: ['cli', 'mcp', 'agent', 'plugin'],
      execution: { target: 'daemon' },
      run: async (_input, context) => context.services.notifications.send({
        clientRequestId: 'document-review-ready',
        categoryId: 'document-review-ready',
        title: 'Document review ready',
      }, { signal: context.signal }),
    },
    'rotate-document-review-webhook-token': {
      title: 'Rotate the document review webhook token',
      description: 'Stores or revokes the plugin-owned webhook credential without returning its value.',
      tool: {
        name: 'document_review_rotate_webhook_token',
        title: 'Rotate document review webhook token',
        description: 'Stores or revokes the document review webhook credential without returning its value.',
      },
      cli: { path: ['document-review', 'rotate-webhook-token'] },
      toolExposure: { agent: 'direct', mcp: 'direct' },
      surfaces: ['cli', 'mcp', 'agent', 'plugin'],
      execution: { target: 'daemon' },
      inputHints: { fields: [{ path: 'token', title: 'Webhook token', widget: 'secret' }] },
      inputSchema: {
        type: 'object',
        properties: { token: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      resultSchema: {
        type: 'object',
        properties: {
          state: { type: 'string' },
          revision: { type: 'string' },
        },
        required: ['state', 'revision'],
        additionalProperties: false,
      },
      run: async (input, context): Promise<WebhookTokenRotation> => {
        const secrets = context.services.secrets;
        // Read the current revision first so a concurrent rotation loses instead
        // of silently overwriting the incumbent credential.
        const current = await secrets.status(DOCUMENT_REVIEW_WEBHOOK_TOKEN);
        const replacement = readRotationToken(input);
        if (replacement === null) {
          if (current.state !== 'configured') {
            return { state: current.state, revision: current.revision };
          }
          const revoked = await secrets.delete(DOCUMENT_REVIEW_WEBHOOK_TOKEN, {
            expectedRevision: current.revision,
            signal: context.signal,
          });
          return { state: 'missing', revision: revoked.revision };
        }
        const stored = await secrets.set(DOCUMENT_REVIEW_WEBHOOK_TOKEN, replacement, {
          ...(current.state === 'configured' ? { expectedRevision: current.revision } : {}),
          signal: context.signal,
        });
        // Read back at the point of use with a user-readable reason. The value
        // stays inside this handler; only the state and revision are returned.
        const confirmed = await secrets.get(DOCUMENT_REVIEW_WEBHOOK_TOKEN, {
          reason: 'Confirm the rotated document review webhook credential',
          signal: context.signal,
        });
        if (confirmed !== replacement) {
          throw new Error('document_review_webhook_token_rotation_unconfirmed');
        }
        return { state: 'configured', revision: stored.revision };
      },
    },
    'forward-to-session-run': {
      title: 'Forward to Session execution run',
      description: 'Sends one trusted plugin message to a Session-owned execution run through the canonical Session handle, preserving the same recipient and attachment capabilities as built-ins.',
      tool: {
        name: 'document_review_forward_to_run',
        description: 'Sends one trusted message to a Session-owned execution run with the same recipient and attachment capabilities as built-ins.',
      },
      cli: { path: ['document-review', 'forward-to-run'] },
      toolExposure: { agent: 'direct', mcp: 'direct' },
      surfaces: ['cli', 'mcp', 'agent', 'plugin'],
      execution: { target: 'daemon' },
      dangerLevel: 'safe',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', minLength: 1 },
          runId: { type: 'string', minLength: 1 },
          text: { type: 'string', minLength: 1 },
          idempotencyKey: { type: 'string', minLength: 1 },
          attachmentEntryId: { type: 'string', minLength: 1 },
        },
        required: ['sessionId', 'runId', 'text', 'idempotencyKey'],
        additionalProperties: false,
      },
      run: async (input, context) => {
        const parsed = readForwardToSessionRunInput(input);
        // Canonical trusted-plugin seam: the host binds Session identity and stamps
        // plugin caller provenance, then dispatches through the single
        // `session.message.send` Action executor. No second registry, no
        // host-internal import, no per-field encryption.
        const session = await context.services.sessions.get(parsed.sessionId, {
          signal: context.signal,
        });
        if (!session) {
          throw new Error('forward_session_unavailable');
        }
        return session.send(
          {
            kind: 'userText',
            text: parsed.text,
            idempotencyKey: parsed.idempotencyKey,
            recipient: { kind: 'execution_run', runId: parsed.runId },
            ...(parsed.attachmentEntryId === undefined
              ? {}
              : {
                  attachments: [
                    {
                      attachmentLocalId: 'entry',
                      value: {
                        key: `github:pull:${parsed.attachmentEntryId}`,
                        value: { sourceId: 'github', entryId: parsed.attachmentEntryId },
                        presentation: { label: `PR #${parsed.attachmentEntryId}` },
                      },
                    },
                  ],
                }),
          },
          { signal: context.signal },
        );
      },
    },
  },
  secrets: [{ id: DOCUMENT_REVIEW_WEBHOOK_TOKEN }],
  resources: {
    [DOCUMENT_REVIEW_SERVICE_RESOURCE]: {
      source: 'dynamic',
      kind: 'template',
      scope: 'global',
      contentType: 'text/plain',
      maxBytes: DOCUMENT_REVIEW_SERVICE_RESOURCE_BYTES.byteLength,
      runtime: {
        read: () => DOCUMENT_REVIEW_SERVICE_RESOURCE_BYTES.slice(),
        observe: () => ({ dispose: () => undefined }),
      },
    },
  },
  events: {
    [DOCUMENT_REVIEW_SERVICES_EVENT]: {
      declaration: {
        kind: 'event',
        title: 'Document review services inspected',
        payloadSchema: {
          type: 'object',
          properties: { source: { type: 'string' } },
          required: ['source'],
          additionalProperties: false,
        },
      },
    },
    'watch-document-review-services': {
      declaration: {
        kind: 'subscription',
        target: { kind: 'plugin', event: documentReviewServicesEventRef },
      },
      handler: async () => undefined,
    },
  },
  notifications: {
    'document-review-ready': {
      kind: 'activity',
      title: 'Document review ready',
      eventIds: [],
      defaultChannels: ['webhook'],
    },
  },
  notificationChannels: {
    webhook: {
      declaration: {
        kind: 'webhook',
        title: 'Document review webhook',
        configurable: true,
        defaultEnabled: true,
        settings: [{
          id: 'endpoint',
          title: 'Webhook URL',
          schema: { type: 'string', minLength: 1 },
          default: 'https://review.example.test/hooks/ready',
        }],
      },
      sender: documentReviewNotificationSender,
    },
  },
  browserTargets: {
    'document-review': documentReviewBrowserTarget,
  },
  browserActions: {
    'open-document-review-surface': openDocumentReviewBrowserAction,
  },
  requestInterceptors: {
    'document-review-api-policy': {
      declaration: {
        origins: ['https://api.example.test'],
        methods: ['GET'],
      },
      interceptor: documentReviewRequestPolicy,
    },
  },
  contributionPoints: {
    'document-reviewers': TriageSourcesContributionPointV1,
  },
});

documentReviewersPoint = plugin.contributionPoints['document-reviewers'];

export const { manifest, activate } = plugin;
