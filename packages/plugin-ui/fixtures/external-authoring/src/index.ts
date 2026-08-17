import {
  defineComposerAttachment,
  defineComposerControl,
  defineComposerReference,
  defineComposerRegion,
  definePlugin,
} from '@happier-dev/plugin-sdk';
import {
  defineProtocolObject,
  defineProtocolString,
} from '@happier-dev/plugin-sdk/protocol';
import type {
  ComposerAttachmentRuntime,
  JsonValue,
} from '@happier-dev/plugin-sdk';

type ExternalIssueDraft = Readonly<Record<string, JsonValue>>;

const EXTERNAL_ISSUE_VALUE = defineProtocolObject({
  reviewId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const EXTERNAL_PREPARED_ISSUE_VALUE = defineProtocolString();
const EXTERNAL_PREPARED_PREFIX = 'prepared:';
const retryingLocalIds = new Set<string>();
const acceptedMessageLocalIds = new Set<string>();

function readExternalIssueId(value: ExternalIssueDraft): string {
  const reviewId = value.reviewId;
  return typeof reviewId === 'string' ? reviewId : 'unknown';
}

const externalIssueAttachmentRuntime = {
  prepareForSend: async ({ sessionId, localId, attachments }, context) => {
    void sessionId;
    if (context.signal.aborted) {
      return {
        attachments: attachments.map(({ instanceId }) => ({
          instanceId,
          status: 'failed' as const,
          retryable: true,
          message: 'External issue preparation was interrupted.',
        })),
      };
    }

    const shouldRetry = attachments.some(({ key }) => key === 'external-retry')
      && !retryingLocalIds.has(localId);
    if (shouldRetry) retryingLocalIds.add(localId);

    return {
      attachments: attachments.map(({ instanceId, key, value }) => (
        shouldRetry && key === 'external-retry'
          ? {
            instanceId,
            status: 'failed' as const,
            retryable: true,
            message: 'External issue preparation can be retried.',
          }
          : {
            instanceId,
            status: 'ready' as const,
            value: `${EXTERNAL_PREPARED_PREFIX}${readExternalIssueId(value)}`,
          }
      )),
    };
  },
  resolveForDispatch: async ({ sessionId, localId, attachments }, context) => {
    if (context.signal.aborted) {
      return {
        attachments: attachments.map(({ instanceId }) => ({
          instanceId,
          status: 'unavailable' as const,
          retryable: true,
          message: 'External issue resolution was interrupted.',
        })),
      };
    }

    return {
      attachments: attachments.map(({ instanceId, value }) => {
        const issueId = value.startsWith(EXTERNAL_PREPARED_PREFIX)
          ? value.slice(EXTERNAL_PREPARED_PREFIX.length)
          : value;
        return {
          instanceId,
          status: 'ready' as const,
          context: `Fresh external lookup for ${issueId}`,
          data: { issueId, sessionId, localId },
        };
      }),
    };
  },
  afterMessageAccepted: async ({ sessionId, localId }, context) => {
    void sessionId;
    if (context.signal.aborted) return;
    acceptedMessageLocalIds.add(localId);
  },
} satisfies ComposerAttachmentRuntime<ExternalIssueDraft, string>;

export function readExternalAuthoringAcceptedMessageLocalIds(): readonly string[] {
  return [...acceptedMessageLocalIds].sort();
}

/**
 * The one external author package root. Its UI surface lives alongside this
 * manifest in the same clean consumer fixture; the harness adds Composer
 * authoring here rather than creating a second external package path.
 */
export const externalAuthoringPlugin = definePlugin({
  id: 'fixture.external-authoring',
  version: '0.1.0',
  ui: {
    renderers: [{
      id: 'external-authoring-composer-renderer',
      kind: 'declarative',
      root: { kind: 'text', text: 'External authoring Composer surface' },
    }],
    translations: [],
  },
  composer: {
    references: {
      'external-issues': defineComposerReference({
        title: 'External issues',
        icon: 'error',
        triggers: ['@', '$'],
        search: async () => [],
        resolve: async (candidateId) => ({
          id: candidateId,
          label: 'External issue',
          context: `External issue ${candidateId}`,
        }),
      }),
    },
    attachments: {
      'external-issue': defineComposerAttachment({
        title: 'External issue',
        icon: 'error',
        cardinality: 'many',
        value: EXTERNAL_ISSUE_VALUE,
        preparedValue: EXTERNAL_PREPARED_ISSUE_VALUE,
        picker: 'external-authoring-composer-renderer',
        display: {
          kind: 'surface',
          renderer: 'external-authoring-composer-renderer',
          sizing: 'content',
        },
        preview: {
          kind: 'surface',
          renderer: 'external-authoring-composer-renderer',
          presentation: 'popover',
        },
        runtime: externalIssueAttachmentRuntime,
      }),
    },
    controls: {
      'external-issue-control': defineComposerControl({
        label: 'External issue',
        icon: 'error',
        interaction: {
          kind: 'attachmentPicker',
          attachment: 'external-issue',
          presentation: 'popover',
          layout: 'split',
        },
      }),
      'external-issue-apply-control': defineComposerControl({
        label: 'Apply external review draft',
        icon: 'action',
        interaction: {
          kind: 'choices',
          selection: 'single',
          options: [{
            id: 'set-external-review-draft',
            label: 'Set external review draft',
            effect: {
              kind: 'composerApply',
              operations: [{ kind: 'text.set', text: 'External review draft' }],
            },
          }],
        },
      }),
    },
    regions: {
      'external-issue-region': defineComposerRegion({
        placement: 'beforeComposer',
        renderer: 'external-authoring-composer-renderer',
      }),
    },
  },
});

export const { manifest, activate } = externalAuthoringPlugin;
