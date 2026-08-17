import { randomUUID } from 'node:crypto';

import type { PluginApi } from '@happier-dev/plugin-sdk';
import {
  TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
  TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
} from '@happier-dev/triage-protocol/v1';

import { createTriageAdministerSourceInstanceActionHandler } from './actions/administerSourceInstanceAction.js';
import { TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1 } from './actions/entryDetailProtocol.js';
import { createTriageReadConfiguredSourceInstancesActionHandler } from './actions/readConfiguredSourceInstances.js';
import { createTriageReadEntryDetailActionHandler } from './actions/readEntryDetail.js';
import { createTriageInitialScanOwner } from './corpus/configuration/initialScan.js';
import { createTriageListEntriesActionHandler } from './actions/listEntries.js';
import { TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1 } from './actions/listEntriesProtocol.js';
import {
  createTriageListPinnedEntriesActionHandler,
  createTriageSetEntryPinnedActionHandler,
} from './actions/userMarks.js';
import {
  TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
  TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
} from './actions/userMarksProtocol.js';
import {
  createTriageAdministerSavedViewActionHandler,
  createTriageReadSavedViewsActionHandler,
} from './actions/savedViews.js';
import {
  TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
  TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
} from './actions/savedViewsProtocol.js';
import { createTriageLinkEntryToSessionActionHandler } from './actions/sessionLinks.js';
import { TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1 } from './actions/sessionLinksProtocol.js';
import { createTriageEntryAttachmentRuntime } from './composer/attachmentRuntime.js';
import { TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1 } from './composer/attachmentValue.js';

/**
 * The single Triage registration spine, invoked once by the host through the
 * manifest's declared daemon entrypoint.
 *
 * Every Triage runtime registration — the aggregate list read, source
 * administration and session composition — is added here by its owning module.
 * No Triage code registers through a second activation, host branch or package,
 * and nothing is registered that the manifest does not declare.
 */
export function activate(api: PluginApi): void {
  api.actions.register(
    TRIAGE_LIST_ENTRIES_ACTION_LOCAL_ID_V1,
    createTriageListEntriesActionHandler(),
  );
  api.actions.register(
    TRIAGE_SET_ENTRY_PINNED_ACTION_LOCAL_ID_V1,
    createTriageSetEntryPinnedActionHandler(),
  );
  api.actions.register(
    TRIAGE_LIST_PINNED_ENTRIES_ACTION_LOCAL_ID_V1,
    createTriageListPinnedEntriesActionHandler(),
  );
  api.actions.register(
    TRIAGE_LINK_ENTRY_TO_SESSION_ACTION_LOCAL_ID_V1,
    createTriageLinkEntryToSessionActionHandler(),
  );
  api.actions.register(
    TRIAGE_SOURCES_ADMINISTER_ACTION_LOCAL_ID_V1,
    createTriageAdministerSourceInstanceActionHandler({
      // One process-local single-flight owner for the whole plugin generation,
      // so a Select-all configuration scope collapses into one pass per
      // configured instance instead of one per submitted draft. It holds
      // nothing durable and disappears with the process.
      initialScan: createTriageInitialScanOwner({ nowMs: () => Date.now() }),
      mintSourceInstanceId: () => randomUUID(),
      nowMs: () => Date.now(),
    }),
  );
  // The read half of caller-bound source administration: without it a source
  // Settings page can only ADD a source, because `reconfigure`, `remove` and
  // `reactivate` all name an instance the caller has no way to learn.
  api.actions.register(
    TRIAGE_SOURCES_READ_CONFIGURED_ACTION_LOCAL_ID_V1,
    createTriageReadConfiguredSourceInstancesActionHandler(),
  );
  // The durable half of one mounted detail input. Without it the shell can
  // select a row and has nothing admissible to mount a source detail with.
  api.actions.register(
    TRIAGE_READ_ENTRY_DETAIL_ACTION_LOCAL_ID_V1,
    createTriageReadEntryDetailActionHandler(),
  );
  api.actions.register(
    TRIAGE_READ_SAVED_VIEWS_ACTION_LOCAL_ID_V1,
    createTriageReadSavedViewsActionHandler(),
  );
  api.actions.register(
    TRIAGE_ADMINISTER_SAVED_VIEW_ACTION_LOCAL_ID_V1,
    createTriageAdministerSavedViewActionHandler(),
  );
  // The one declared attachment lifecycle role. The manifest declares
  // `runtime.resolveForDispatch`, so the host will invoke it before every
  // dispatch that carries an attached entry.
  api.composerAttachments.register(
    TRIAGE_ENTRY_ATTACHMENT_LOCAL_ID_V1,
    createTriageEntryAttachmentRuntime(),
  );
}
