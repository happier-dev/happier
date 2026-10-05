import type { PluginClientApi, PluginDragSourceRuntime, PluginDropTargetRuntime } from '@happier-dev/plugin-sdk';
import { defineProtocolObject, defineProtocolString } from '@happier-dev/plugin-sdk/protocol';
import {
  TriageEntryLocatorV1Schema,
  TriageEntryRefV1Schema,
  TriageSourceInstanceRefV1Schema,
  TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1,
} from '@happier-dev/triage-protocol/v1';

import {
  TriageEntrySessionLinkDisplayV1Schema,
  TriageLinkEntryToSessionInputV1Schema,
  TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
} from '../../actions/sessionLinksProtocol.js';
import { parseTriageComposerEntryAttachmentValue } from '../../composer/attachmentValue.js';

export const TRIAGE_ENTRY_DRAG_SOURCE_ID_V1 = 'entry-reference';
export const TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1 = 'entry-session';
export const TRIAGE_ENTITY_DRAG_DROP_ARTIFACT_ID_V1 = 'triage-entity-drag-drop-native';

const text = defineProtocolString({ minLength: 1 });
const closed = { policy: 'closed' } as const;

/** Identity and current row presentation, never an href transport or a PR-number guess. */
export const TriageEntryDragReferenceV1Schema = defineProtocolObject({
  entryRef: TriageEntryRefV1Schema,
  sourceInstance: TriageSourceInstanceRefV1Schema,
  lastKnownLocator: TriageEntryLocatorV1Schema,
  title: text,
  subtitle: text,
}, closed);

/** The destination's live row and already-localized release promise. */
export const TriageEntrySessionDropInputV1Schema = defineProtocolObject({
  entryRef: TriageEntryRefV1Schema,
  display: TriageEntrySessionLinkDisplayV1Schema,
  preview: defineProtocolObject({ verb: text, target: text, consequence: text }, closed),
}, closed);

export const triageEntryDragSourceRuntime: PluginDragSourceRuntime = {
  describe(reference) {
    const parsed = TriageEntryDragReferenceV1Schema.safeParse(reference);
    if (!parsed.success) return null;
    // The existing attachment parser owns agreement of entry and configured source.
    const attachment = parseTriageComposerEntryAttachmentValue({
      v: 1, entryRef: parsed.data.entryRef, sourceInstance: parsed.data.sourceInstance,
      lastKnownLocator: parsed.data.lastKnownLocator,
    });
    return attachment.status === 'valid'
      ? { title: parsed.data.title, subtitle: parsed.data.subtitle }
      : null;
  },
};

export const triageEntrySessionDropTargetRuntime: PluginDropTargetRuntime = {
  resolve({ item, targetInput }) {
    const parsed = TriageEntrySessionDropInputV1Schema.safeParse(targetInput);
    if (!parsed.success || item.kind !== 'session') {
      return { status: 'refused', reason: { code: 'triage_entry_session_drop_invalid', message: 'This entry cannot link that item.' } };
    }
    const input = TriageLinkEntryToSessionInputV1Schema.safeParse({
      v: 1, sessionId: item.address.sessionId, entryRef: parsed.data.entryRef, display: parsed.data.display,
    });
    if (!input.success) return { status: 'refused', reason: { code: 'triage_entry_session_drop_invalid', message: 'This Session cannot be linked.' } };
    return {
      status: 'allowed',
      effect: {
        actionId: `plugin:${TRIAGE_SOURCES_TARGET_PLUGIN_ID_V1}/${TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1}`,
        input: input.data,
        preview: parsed.data.preview,
      },
    };
  },
};

/** The ordinary client activation ABI; the mounted host owns effects and retirement. */
export function activate(api: PluginClientApi): void {
  api.dragSources.register(TRIAGE_ENTRY_DRAG_SOURCE_ID_V1, triageEntryDragSourceRuntime);
  api.dropTargets.register(TRIAGE_ENTRY_SESSION_DROP_TARGET_ID_V1, triageEntrySessionDropTargetRuntime);
}
