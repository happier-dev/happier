export const SESSION_ORGANIZATION_SNAPSHOT_VERSION = 1;

export const SESSION_ORGANIZATION_MAX_KEY_LENGTH = 10_000;
// DB-facing ids and indexed sort keys must fit every provider's indexed string width.
// Long legacy/logical identifiers belong in *Key fields and are indexed by hash columns.
export const SESSION_ORGANIZATION_MAX_ID_LENGTH = 191;
export const SESSION_ORGANIZATION_MAX_SORT_KEY_LENGTH = 191;

export const SESSION_ORGANIZATION_MAX_PINNED_SESSIONS = 500;
// Attention standing stores an explicit boolean per session, so a "remove from Needs attention"
// against a true account default persists a row just like a "keep" does. The snapshot is the
// first-paint payload every list refresh parses on the JS thread, so the collection is bounded like
// every other one here; the write path rejects past the bound rather than letting the response grow.
export const SESSION_ORGANIZATION_MAX_ATTENTION_STANDINGS = 500;
export const SESSION_ORGANIZATION_MAX_FOLDERS = 500;
export const SESSION_ORGANIZATION_MAX_TAGS = 500;
export const SESSION_ORGANIZATION_MAX_LABELS = 1_000;
export const SESSION_ORGANIZATION_MAX_ASSIGNMENTS_PER_MUTATION = 500;
export const SESSION_ORGANIZATION_MAX_ORDER_ENTRIES_PER_SCOPE = 1_000;
export const SESSION_ORGANIZATION_MAX_SCOPED_SNAPSHOT_IDS = 500;
export const SESSION_ORGANIZATION_MAX_DISPLAY_ENVELOPE_BYTES = 64 * 1024;

export const SESSION_ORGANIZATION_ORDER_SCOPE_KINDS = ['pinned', 'folder', 'tag', 'workspace', 'group'] as const;
export const SESSION_ORGANIZATION_ORDER_ITEM_KINDS = ['session', 'folder', 'tag', 'workspace', 'group'] as const;
export const SESSION_ORGANIZATION_LABEL_KINDS = ['workspace', 'group'] as const;

export const SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENT_BEHAVIORS = ['moveAssignmentsToParent'] as const;
export const SESSION_ORGANIZATION_FOLDER_DELETE_ASSIGNMENTS_DEFAULT = 'moveAssignmentsToParent';

export const SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENT_BEHAVIORS = ['removeAssignments'] as const;
export const SESSION_ORGANIZATION_TAG_DELETE_ASSIGNMENTS_DEFAULT = 'removeAssignments';
