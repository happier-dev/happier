import {
  COMPOSER_MEDIA_CONTENT_CAPABILITY_V1,
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

import {
  ISSUE_SURFACE_ARTIFACT_ID,
  ISSUE_SURFACE_RENDERER_ID,
} from './uiBuildIdentity.mjs';

const ISSUE_VALUE = defineProtocolObject({
  issueId: defineProtocolString({ minLength: 1 }),
}, { policy: 'closed' });
const PREPARED_ISSUE_VALUE = defineProtocolString();
const PREPARED_ISSUE_PREFIX = 'prepared:';
const ISSUE_CONTROL_STATE_BYTES = new TextEncoder().encode(JSON.stringify({
  enabled: true,
  label: 'External issues',
}));
const DAEMON_ISSUE_MEDIA_SOURCE = Object.freeze({
  root: 'pluginData',
  relativePath: 'daemon-issue-evidence.png',
});
const DAEMON_ISSUE_MEDIA_BYTES = Uint8Array.from([
  137, 80, 78, 71, 13, 10, 26, 10,
  0, 0, 0, 13, 73, 72, 68, 82,
  0, 0, 0, 1, 0, 0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2,
  0, 0, 0, 11, 73, 68, 65, 84, 120, 218, 99, 100, 248, 15, 0, 1, 5, 1, 1,
  39, 24, 227, 102,
  0, 0, 0, 0, 73, 69, 78, 68, 174, 66, 96, 130,
]);
/** @type {Set<string>} */
const retriedPreparationLocalIds = new Set();
/** @type {Set<string>} */
const acceptedMessageLocalIds = new Set();

/**
 * @typedef {Readonly<{ issueId: string }>} IssueDraft
 */

/** @param {IssueDraft} value */
function readIssueId(value) {
  return typeof value?.issueId === 'string' ? value.issueId : 'unknown';
}

/** @type {import('@happier-dev/plugin-sdk').ComposerAttachmentRuntime<IssueDraft, string>} */
const issueAttachmentRuntime = {
  async prepareForSend({ sessionId, localId, attachments }, context) {
    void sessionId;
    if (context.signal.aborted) {
      return {
        attachments: attachments.map(({ instanceId }) => ({
          instanceId,
          status: 'failed',
          retryable: true,
          message: 'Issue preparation was interrupted.',
        })),
      };
    }

    const shouldRetry = attachments.some(({ key }) => key === 'external-retry')
      && !retriedPreparationLocalIds.has(localId);
    if (shouldRetry) retriedPreparationLocalIds.add(localId);

    return {
      attachments: attachments.map(({ instanceId, key, value }) => (
        shouldRetry && key === 'external-retry'
          ? {
            instanceId,
            status: 'failed',
            retryable: true,
            message: 'Issue preparation can be retried.',
          }
          : {
            instanceId,
            status: 'ready',
            value: `${PREPARED_ISSUE_PREFIX}${readIssueId(value)}`,
          }
      )),
    };
  },
  async resolveForDispatch({ sessionId, localId, attachments }, context) {
    if (context.signal.aborted) {
      return {
        attachments: attachments.map(({ instanceId }) => ({
          instanceId,
          status: 'unavailable',
          retryable: true,
          message: 'Issue resolution was interrupted.',
        })),
      };
    }

    return {
      attachments: attachments.map(({ instanceId, value }) => {
        const issueId = value.startsWith(PREPARED_ISSUE_PREFIX)
          ? value.slice(PREPARED_ISSUE_PREFIX.length)
          : value;
        return {
          instanceId,
          status: 'ready',
          context: `Fresh external lookup for ${issueId}`,
          data: { issueId, sessionId, localId },
        };
      }),
    };
  },
  async afterMessageAccepted({ sessionId, localId }, context) {
    void sessionId;
    if (context.signal.aborted) return;
    acceptedMessageLocalIds.add(localId);
  },
};

/** @type {import('@happier-dev/plugin-sdk').ComposerAttachmentRuntime<IssueDraft>} */
const issueMediaAttachmentRuntime = {
  async prepareForSend({ attachments }, context) {
    const contentless = attachments.filter(({ content }) => content === undefined);
    if (contentless.length === 0) {
      return {
        attachments: attachments.map(({ instanceId, value, content }) => ({
          instanceId,
          status: 'ready',
          value,
          content,
        })),
      };
    }

    const availability = context.services.composerContent.capabilities()[
      COMPOSER_MEDIA_CONTENT_CAPABILITY_V1
    ];
    if (availability.status !== 'available') {
      return {
        attachments: attachments.map(({ instanceId, value, content }) => (
          content === undefined
            ? {
              instanceId,
              status: 'unavailable',
              retryable: true,
              message: 'Daemon-origin image staging is unavailable.',
            }
            : { instanceId, status: 'ready', value, content }
        )),
      };
    }

    await context.services.fs.writeFile(
      DAEMON_ISSUE_MEDIA_SOURCE,
      DAEMON_ISSUE_MEDIA_BYTES.slice(),
      { signal: context.signal },
    );
    /** @type {import('@happier-dev/plugin-sdk').ComposerAttachmentPrepareOutcomeV1<IssueDraft>[]} */
    const prepared = [];
    for (const attachment of attachments) {
      if (attachment.content !== undefined) {
        prepared.push({
          instanceId: attachment.instanceId,
          status: 'ready',
          value: attachment.value,
          content: attachment.content,
        });
        continue;
      }
      const handle = await context.services.composerContent.stageMedia({
        source: DAEMON_ISSUE_MEDIA_SOURCE,
        name: 'daemon-issue-evidence.png',
        mimeType: 'image/png',
      }, { signal: context.signal });
      prepared.push({
        instanceId: attachment.instanceId,
        status: 'ready',
        value: attachment.value,
        content: { kind: 'stagedMedia', handle },
      });
    }
    return { attachments: prepared };
  },
};

export function readAcceptedMessageLocalIds() {
  return [...acceptedMessageLocalIds].sort();
}

const issueDogfoodPlugin = definePlugin({
  id: 'acme.composer.issue-dogfood',
  version: '0.0.0',
  ui: {
    renderers: [{
      id: ISSUE_SURFACE_RENDERER_ID,
      kind: 'reactNative',
      artifact: ISSUE_SURFACE_ARTIFACT_ID,
      requiredHostMethods: [
        'readComposer',
        'watchComposer',
        'applyComposer',
        'pickComposerMedia',
        'inspectComposerContent',
        'releaseComposerContent',
      ],
    }],
  },
  resources: {
    'issue-control-state': {
      source: 'dynamic',
      kind: 'config',
      contentType: 'application/vnd.happier.composer-control-state+json;v=1',
      maxBytes: 4096,
      scope: 'global',
      runtime: {
        read: async () => ISSUE_CONTROL_STATE_BYTES.slice(),
        observe: () => ({ dispose: () => undefined }),
      },
    },
  },
  composer: {
    references: {
      issues: defineComposerReference({
        title: 'Issues',
        icon: 'error',
        triggers: ['@', '$'],
        search: async () => [],
        resolve: async (candidateId) => ({
          id: candidateId,
          label: 'Issue',
          context: `External issue ${candidateId}`,
        }),
      }),
    },
    attachments: {
      issue: defineComposerAttachment({
        title: 'Issue',
        description: 'Attach issue context to the next message',
        icon: 'error',
        cardinality: 'many',
        value: ISSUE_VALUE,
        preparedValue: PREPARED_ISSUE_VALUE,
        picker: ISSUE_SURFACE_RENDERER_ID,
        display: {
          kind: 'surface',
          renderer: ISSUE_SURFACE_RENDERER_ID,
          sizing: 'compact',
        },
        preview: {
          kind: 'surface',
          renderer: ISSUE_SURFACE_RENDERER_ID,
          presentation: 'popover',
        },
        runtime: issueAttachmentRuntime,
      }),
      'issue-media': defineComposerAttachment({
        title: 'Issue image evidence',
        description: 'Attach portable image evidence to the next message',
        icon: 'preview',
        cardinality: 'many',
        value: ISSUE_VALUE,
        runtime: issueMediaAttachmentRuntime,
      }),
    },
    controls: {
      'issue-control': defineComposerControl({
        label: 'Issue',
        icon: 'error',
        state: { resource: 'issue-control-state' },
        compactRenderer: ISSUE_SURFACE_RENDERER_ID,
        overflow: {
          label: 'More external issue actions',
          icon: 'more',
        },
        interaction: {
          kind: 'attachmentPicker',
          attachment: 'issue',
          presentation: 'popover',
          layout: 'split',
        },
      }),
    },
    regions: {
      warning: defineComposerRegion({
        placement: 'beforeComposer',
        renderer: ISSUE_SURFACE_RENDERER_ID,
      }),
    },
  },
});

export const { manifest, activate } = issueDogfoodPlugin;
