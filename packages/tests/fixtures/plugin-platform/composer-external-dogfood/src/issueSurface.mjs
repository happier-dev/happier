import { Fragment, createElement, useState } from 'react';
import {
  Card,
  Icon,
  List,
  Status,
  Text,
  defineUiSurface,
  useComposer,
  useComposerView,
} from '@happier-dev/plugin-ui';

import {
  attachDaemonIssueMediaFromCurrentComposer,
  attachIssueMediaFromCurrentComposer,
  attachIssueWithoutControl,
  createIssueAttachmentAuthorValue,
  inspectAndReleaseIssueMediaFromCurrentComposer,
} from './issueComposer.mjs';

export { attachIssueWithoutControl };

const ISSUE_CHOICES = Object.freeze([
  Object.freeze({ issueId: 'EXT-42', title: 'Issue EXT-42' }),
  Object.freeze({ issueId: 'EXT-84', title: 'Issue EXT-84' }),
]);

const ISSUE_ATTACHMENT_IDENTITY = Object.freeze({
  pluginId: 'acme.composer.issue-dogfood',
  localId: 'issue',
});
const ISSUE_COMPACT_FALLBACK = Object.freeze({
  label: 'Issue',
  icon: 'error',
});

/** @param {unknown} value */
function asRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}

/** @param {unknown} launchInput */
function readSurfaceRole(launchInput) {
  const role = asRecord(launchInput)?.role;
  return typeof role === 'string' ? role : 'unavailable';
}

/** @param {unknown} launchInput */
function readAttachmentView(launchInput) {
  return asRecord(asRecord(launchInput)?.instance);
}

/** @param {Record<string, unknown> | null} instance */
function readIssuePresentation(instance) {
  const value = asRecord(instance?.value);
  const presentation = asRecord(instance?.presentation);
  const availability = asRecord(instance?.availability);
  const issueId = typeof value?.issueId === 'string' ? value.issueId : 'unknown';
  return Object.freeze({
    issueId,
    label: typeof presentation?.label === 'string'
      ? presentation.label
      : `Issue ${issueId}`,
    description: typeof presentation?.description === 'string'
      ? presentation.description
      : 'External issue context',
    ready: availability?.status === 'ready',
  });
}

/** @param {import('@happier-dev/plugin-ui').ComposerViewStateV1} view */
function readCompactIssuePresentation(view) {
  // A compact renderer is only a consumer of the canonical handle snapshot.
  // While the handle has no current fact, retain the declaration's useful
  // static presentation rather than making loading/error state a new owner.
  if (view.pending !== null || view.error !== null || view.result?.status !== 'ready') {
    return ISSUE_COMPACT_FALLBACK;
  }

  const issues = view.result.snapshot.attachments.filter((attachment) => (
    attachment.attachment.pluginId === ISSUE_ATTACHMENT_IDENTITY.pluginId
      && attachment.attachment.localId === ISSUE_ATTACHMENT_IDENTITY.localId
  ));
  if (issues.length === 0) return ISSUE_COMPACT_FALLBACK;
  if (issues.length === 1) {
    const [issue] = issues;
    return Object.freeze({
      label: issue.presentation.label,
      icon: issue.presentation.icon ?? ISSUE_COMPACT_FALLBACK.icon,
    });
  }
  return Object.freeze({
    label: `${issues.length} issues`,
    icon: ISSUE_COMPACT_FALLBACK.icon,
  });
}

function ComposerIssueCompact() {
  const handle = useComposer().current();
  const presentation = readCompactIssuePresentation(useComposerView(handle));
  return createElement(
    Fragment,
    null,
    createElement(Icon, { name: presentation.icon, tone: 'secondary' }),
    createElement(Status, { tone: 'neutral', label: presentation.label }),
  );
}

/**
 * @param {import('@happier-dev/plugin-sdk/ui').RenderContext} context
 */
function ComposerIssueSurface({ launchInput }) {
  const composers = useComposer();
  const [pickerStatus, setPickerStatus] = useState(
    /** @type {string | undefined} */ (undefined),
  );
  const role = readSurfaceRole(launchInput);

  if (role === 'controlCompact') {
    return createElement(ComposerIssueCompact);
  }

  if (role === 'attachmentPicker') {
    /** @param {string} issueId */
    const attachIssue = async (issueId) => {
      const handle = await composers.current();
      if (!handle) {
        setPickerStatus('Issue attachment unavailable');
        return;
      }
      const read = await handle.read();
      if (read.status !== 'ready' || !read.snapshot.capabilities.attachments) {
        setPickerStatus('Issue attachment unavailable');
        return;
      }
      const result = await handle.apply({
        expectedRevision: read.snapshot.revision,
        operations: [{
          kind: 'attachment.add',
          attachmentLocalId: 'issue',
          value: createIssueAttachmentAuthorValue(issueId),
        }],
      });
      setPickerStatus(
        result.status === 'applied'
          ? `Attached Issue ${issueId}`
          : 'Issue attachment unavailable',
      );
    };

    return createElement(
      Fragment,
      null,
      createElement(
        List,
        { accessibilityLabel: 'External issue picker' },
        ...ISSUE_CHOICES.map((issue) => createElement(List.Item, {
          key: issue.issueId,
          title: `Attach ${issue.title}`,
          accessibilityRole: 'option',
          onPress: () => attachIssue(issue.issueId),
        })),
        createElement(List.Item, {
          key: 'issue-media-daemon-attach',
          title: 'Attach daemon-origin image evidence for Issue EXT-84',
          accessibilityRole: 'option',
          onPress: async () => {
            const result = await attachDaemonIssueMediaFromCurrentComposer(composers, 'EXT-84');
            setPickerStatus(
              result.status === 'applied'
                ? 'Queued daemon-origin image evidence for Issue EXT-84'
                : 'Issue image evidence unavailable',
            );
          },
        }),
        createElement(List.Item, {
          key: 'issue-media-attach',
          title: 'Attach image evidence for Issue EXT-42',
          accessibilityRole: 'option',
          onPress: async () => {
            const result = await attachIssueMediaFromCurrentComposer(composers, 'EXT-42');
            setPickerStatus(
              result.status === 'applied'
                ? 'Attached image evidence for Issue EXT-42'
                : 'Issue image evidence unavailable',
            );
          },
        }),
        createElement(List.Item, {
          key: 'issue-media-release',
          title: 'Inspect and release image evidence',
          accessibilityRole: 'option',
          onPress: async () => {
            const result = await inspectAndReleaseIssueMediaFromCurrentComposer(composers);
            setPickerStatus(
              'bytes' in result
                ? 'Released staged image evidence'
                : 'Issue image evidence unavailable',
            );
          },
        }),
      ),
      pickerStatus === undefined
        ? null
        : createElement(Status, {
          tone: pickerStatus.startsWith('Attached') || pickerStatus.startsWith('Queued')
            ? 'success'
            : 'warning',
          label: pickerStatus,
        }),
    );
  }

  if (role === 'attachmentDisplay' || role === 'attachmentPreview') {
    const issue = readIssuePresentation(readAttachmentView(launchInput));
    return createElement(
      Card,
      null,
      createElement(Text, { value: issue.label, variant: 'title' }),
      role === 'attachmentPreview'
        ? createElement(Text, { value: issue.description, tone: 'secondary' })
        : createElement(Status, {
          tone: issue.ready ? 'success' : 'warning',
          label: issue.ready ? 'Issue ready' : 'Issue unavailable',
        }),
    );
  }

  if (role === 'region') {
    return createElement(Status, {
      tone: 'warning',
      label: 'External issue context resolves immediately before dispatch',
    });
  }

  return createElement(Status, {
    tone: 'warning',
    label: 'External issue surface unavailable',
  });
}

export const renderComposerIssueSurface = defineUiSurface(ComposerIssueSurface);
