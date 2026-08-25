import type {
    HappierListMultiSelectionActions,
    HappierListMultiSelectionKey,
    HappierListMultiSelectionSnapshot,
    HappierListMultiSelectionState,
    HappierListMultiSelectionStore,
} from '@happier-dev/plugin-ui/presentation';

/**
 * The sessions list's names for the ONE keyed multi-selection contract.
 *
 * The state machine, its snapshot shape and its subscribable store live at
 * `@happier-dev/plugin-ui`'s collection owner, where the shared `List` and every
 * plugin list bind the same rules. These aliases keep the sessions list's local
 * vocabulary — `SessionListSelection*` reads better at its call sites than the
 * package-qualified name — without giving the concept a second definition to
 * drift from.
 */
export type SessionListSelectionKey = HappierListMultiSelectionKey;

export type SessionListSelectionSnapshot = HappierListMultiSelectionSnapshot;

export type SessionListSelectionState = HappierListMultiSelectionState;

export type SessionListSelectionActions = HappierListMultiSelectionActions;

export type SessionListSelectionStore = HappierListMultiSelectionStore;
