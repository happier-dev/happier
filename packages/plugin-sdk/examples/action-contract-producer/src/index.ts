import { definePlugin } from '@happier-dev/plugin-sdk';
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

/**
 * The rotation result reuses the service's own state vocabulary instead of
 * respelling it, and carries a revision so a caller can reject a stale update.
 */
type WebhookTokenRotation = Readonly<{
  state: SecretStatus['state'];
  revision: string;
}>;

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
  id: 'examples.action-contract-producer',
  version: '0.1.0',
  displayName: 'Document Reviewer Target',
  runtime: { apiVersion: Number(PUBLIC_TOOLCHAIN_COMPATIBILITY_V1.framework.runtime) as 1 },
  entrypoints: { daemon: './dist/index.js' },
  actions: {
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
      surfaces: ['cli', 'plugin'],
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
  commands: {
    'send-document-review-ready-command': {
      title: 'Send document review notification',
      path: ['document-review', 'notify-ready'],
      action: 'send-document-review-ready',
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

export const { manifest, activate } = plugin;
