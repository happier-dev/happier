import {
  definePlugin,
  type TargetedContributionPointRef,
} from '@happier-dev/plugin-sdk';
import {
  PUBLIC_TOOLCHAIN_COMPATIBILITY_V1,
  type BrowserActionContributionInput,
  type BrowserTargetContributionInput,
} from '@happier-dev/plugin-sdk/browser';
import type { PluginRequestInterceptor } from '@happier-dev/plugin-sdk/http';
import type { NotificationSender } from '@happier-dev/plugin-sdk/notifications';
import type { SecretStatus } from '@happier-dev/plugin-sdk/secrets';
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
    required: [{
      id: 'document-review-service-files',
      capability: 'filesystem',
      reason: 'Inspect and remove the plugin-local document review service check.',
      scope: {
        locations: [{ root: 'pluginData', pathPrefix: 'service-check' }],
        access: ['read', 'write', 'delete'],
      },
    }],
  },
  actions: {
    'inspect-document-review-services': {
      title: 'Inspect document review services',
      description: 'Checks the declared document review services without retaining plugin-local data.',
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
        const resourceWatch = context.services.resources.watch(
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
            generation: snapshot.generation,
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
    'open-document-review': {
      title: 'Open document review',
      surfaces: ['plugin'],
      execution: { target: 'daemon' },
      run: async () => null,
    },
    'send-document-review-ready': {
      title: 'Send document review notification',
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
      surfaces: ['cli', 'mcp', 'agent', 'plugin'],
      execution: { target: 'daemon' },
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
  commands: {
    'send-document-review-ready-command': {
      title: 'Send document review notification',
      path: ['document-review', 'notify-ready'],
      action: 'send-document-review-ready',
    },
    'inspect-document-review-services-command': {
      title: 'Inspect document review services',
      path: ['document-review', 'inspect-services'],
      action: 'inspect-document-review-services',
    },
    'rotate-document-review-webhook-token-command': {
      title: 'Rotate document review webhook token',
      path: ['document-review', 'rotate-webhook-token'],
      action: 'rotate-document-review-webhook-token',
    },
  },
  tools: {
    'send-document-review-ready-tool': {
      name: 'document_review_notify_ready',
      title: 'Send document review notification',
      description: 'Delivers a review-ready notification through the configured channel.',
      surfaces: ['agent', 'mcp'],
      action: 'send-document-review-ready',
    },
    'inspect-document-review-services-tool': {
      name: 'document_review_inspect_services',
      title: 'Inspect document review services',
      description: 'Checks the declared document review services without retaining plugin-local data.',
      surfaces: ['agent', 'mcp'],
      action: 'inspect-document-review-services',
    },
    'rotate-document-review-webhook-token-tool': {
      name: 'document_review_rotate_webhook_token',
      title: 'Rotate document review webhook token',
      description: 'Stores or revokes the document review webhook credential without returning its value.',
      surfaces: ['agent', 'mcp'],
      action: 'rotate-document-review-webhook-token',
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
