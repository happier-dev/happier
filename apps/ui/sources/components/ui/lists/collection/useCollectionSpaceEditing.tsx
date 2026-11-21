import * as React from 'react';
import type { View } from 'react-native';
import {
  getDefaultCollectionSpaceIdV1,
  type CollectionEntityKindV1,
  type CollectionSpaceIconV1,
  type CollectionSpaceMutationV1,
  type CollectionSpaceV1,
  type SessionSpaceMembershipV1,
} from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';
import type { CollectionFilterMapV1 } from '@happier-dev/protocol/collections/filter/entityListFilterV1';
import type { ResourceSpaceMembershipV1 } from '@happier-dev/protocol/collections/spaces/resourceSpaceMembershipV1';

import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import type { UiActionOperation } from '@/sync/ops/actions/frontDoorRuntimeActionExecutor';
import {
  MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS,
  Popover,
} from '@/components/ui/popover';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { selectCollectionSpace } from '@/sync/domains/session/listing/sessionListSpaces';
import type { AccountSettingsScope } from '@/sync/domains/settings/scope/accountSettingsScope';
import { collectionSpaceSettingRefs } from '@/components/settings/session/collectionSpaceSettings';
import { COLLECTION_SPACE_KIND_PRESENTATION } from '@/components/settings/session/collectionSpaceKindPresentation';
import { Modal } from '@/modal';
import { randomUUID } from '@/platform/randomUUID';
import { t, type TranslationKeyNoParams } from '@/text';

import {
  CollectionSpaceForm,
  type CollectionSpaceFormValue,
} from './CollectionSpaceForm';

const FORM_POPOVER_WIDTH_PX = 340;

/** The membership a create and an edit carry, per list kind: Session and Review spaces have one. */
type SpaceMembershipFor = {
  [P in CollectionEntityKindV1]: (mode: SessionSpaceMembershipV1['mode'] | undefined) => Readonly<{
    create: CollectionSpaceV1<P>['membership'];
    edit: (P extends 'sessionWork' ? Pick<SessionSpaceMembershipV1, 'mode'> : P extends 'review' ? ResourceSpaceMembershipV1 : never) | undefined;
  }>;
};
const NO_MEMBERSHIP = { create: undefined, edit: undefined } as const;
const SPACE_MEMBERSHIP_FOR: SpaceMembershipFor = {
  sessionWork: (mode) => (mode ? { create: { mode, tags: [] }, edit: { mode } } : NO_MEMBERSHIP),
  workflow: () => NO_MEMBERSHIP,
  workflowRun: () => NO_MEMBERSHIP,
  discussion: () => NO_MEMBERSHIP,
  deploymentEnvironment: () => NO_MEMBERSHIP,
  // A Review space's manual members are Account-scoped associations (P02), not tags on its definition.
  review: (mode) => (mode ? { create: { mode }, edit: { mode } } : NO_MEMBERSHIP),
};

type CollectionSpaceKindMembershipKeys = Readonly<{ smart: TranslationKeyNoParams; manual: TranslationKeyNoParams }>;

type SpaceForm = Readonly<{
  mode: 'create' | 'edit';
  error: string | null;
  busy: boolean;
}>;

/**
 * One owner for a saved-space list's space writes (lab `clfilter:save`), whatever it lists: the
 * `settings.invoke` `<entity>.list.spaces` intent (create, edit, delete, reset, reorder), the selected-space
 * device-local selection, and the save/edit form hanging from the list's header. Sessions, Workflows and Discussions bind
 * it with their own filter and summary; nothing here knows what a filter means.
 */
export function useCollectionSpaceEditing<K extends CollectionEntityKindV1>(
  input: Readonly<{
    entityKind: K;
    testIDPrefix: string;
    scope: AccountSettingsScope | null;
    spaces: readonly CollectionSpaceV1<K>[];
    selectedSpace: CollectionSpaceV1<K> | null;
    /** The stored shape of what the list shows now (the space plus its transient conditions). */
    currentFilter: CollectionFilterMapV1[K];
    /** A new space's prefill, from the conditions on screen. */
    suggestion: Readonly<{ name: string; icon: CollectionSpaceIconV1 }>;
    /** What the space keeps, one short phrase per condition. */
    summary: readonly string[];
    /** Whether the list offers "Include needs-you from everywhere" (Sessions). */
    everywhereChoice?: boolean;
    anchorRef: React.RefObject<View | null>;
    /** Called before the form opens (the condition editor closes, so one surface hangs at a time). */
    onWillOpenForm?: () => void;
  }>,
) {
  const { entityKind, selectedSpace, currentFilter } = input;
  // Session and Review spaces carry manual membership; TypeScript cannot narrow a generic K.
  const membershipKind = entityKind === 'sessionWork' || entityKind === 'review';
  const spaceMembership = membershipKind
    ? (selectedSpace as CollectionSpaceV1<'sessionWork' | 'review'> | null)?.membership
    : undefined;
  const refs = React.useMemo(
    () => collectionSpaceSettingRefs(entityKind),
    [entityKind],
  );
  const defaultSpaceId = getDefaultCollectionSpaceIdV1(entityKind);
  const serverId = input.scope?.serverId;
  const accountId = input.scope?.accountId;
  // The executor's result object is new every render; only its `execute` keeps an identity per binding.
  const { execute } = useMountedActionExecution(serverId ?? null);
  const [form, setForm] = React.useState<SpaceForm | null>(null);

  const invoke = React.useCallback(
    async (mutation: CollectionSpaceMutationV1<K>, operation?: UiActionOperation): Promise<boolean> => {
      try {
        const result = await execute('settings.invoke', {
          anchor: refs.spaces.anchor,
          input: { kind: 'collection_space', entityKind, mutation },
        }, operation);
        const status = result.ok
          ? (result.result as { status?: unknown } | null)?.status
          : undefined;
        return status === 'completed';
      } catch {
        return false;
      }
    },
    [execute, entityKind, refs.spaces.anchor],
  );

  const selectSpace = React.useCallback(
    (spaceId: string): boolean => {
      if (!serverId || !accountId) return false;
      selectCollectionSpace({ serverId, accountId }, entityKind, spaceId);
      return true;
    },
    [serverId, accountId, entityKind],
  );

  const onWillOpenForm = input.onWillOpenForm;
  const openSaveAs = React.useCallback(() => {
    onWillOpenForm?.();
    setForm({ mode: 'create', error: null, busy: false });
  }, [onWillOpenForm]);
  const openEdit = React.useCallback(() => {
    onWillOpenForm?.();
    setForm({ mode: 'edit', error: null, busy: false });
  }, [onWillOpenForm]);
  const closeForm = React.useCallback(() => setForm(null), []);
  const saveChanges = React.useCallback(() => {
    if (!selectedSpace) return;
    void invoke({
      op: 'edit',
      spaceId: selectedSpace.id,
      changes: { filter: currentFilter },
    });
  }, [currentFilter, invoke, selectedSpace]);
  const submitForm = React.useCallback(
    async (value: CollectionSpaceFormValue) => {
      if (!form) return;
      const { membershipMode, ...fields } = value;
      const membershipFor: SpaceMembershipFor[K] = SPACE_MEMBERSHIP_FOR[entityKind];
      const membership = membershipFor(membershipMode);
      setForm({ ...form, busy: true, error: null });
      const accepted =
        form.mode === 'create'
          ? await invoke({
              op: 'create',
              space: {
                entityKind,
                id: randomUUID(),
                ...fields,
                ...(membership.create ? { membership: membership.create } : {}),
                filter: currentFilter,
              },
            })
          : selectedSpace
            ? await invoke({
                op: 'edit',
                spaceId: selectedSpace.id,
                changes: { ...fields, ...(membership.edit ? { membership: membership.edit } : {}), filter: currentFilter },
              })
            : false;
      setForm((current) =>
        current === null
          ? null
          : accepted
            ? null
            : {
                ...current,
                busy: false,
                error: t('sessionsList.spacesSaveFailed'),
              },
      );
    },
    [currentFilter, entityKind, form, invoke, selectedSpace],
  );
  const deleteSelected = React.useCallback(async () => {
    if (!selectedSpace) return;
    if (selectedSpace.id === defaultSpaceId) {
      if (await invoke({ op: 'resetDefault' })) setForm(null);
      return;
    }
    // Removing a definition keeps one confirmation (P6 §7.1); the sessions it held stay where they are.
    const confirmed = await Modal.confirm(
      t('sessionsList.spacesDeleteTitle', { name: selectedSpace.name }),
      t('sessionsList.spacesDeleteBody'),
      { confirmText: t('sessionsList.spacesDelete'), destructive: true },
    );
    if (!confirmed) return;
    if (await invoke({ op: 'delete', spaceId: selectedSpace.id }, { confirmed: true })) setForm(null);
  }, [defaultSpaceId, invoke, selectedSpace]);
  /** Moves a space before another (null: to the end); the strip, menu, swipes and digits follow the order. */
  const reorder = React.useCallback(
    (spaceId: string, beforeSpaceId: string | null) =>
      invoke({ op: 'reorder', spaceId, beforeSpaceId }),
    [invoke],
  );

  const presentation = COLLECTION_SPACE_KIND_PRESENTATION[entityKind];
  const membershipKeys: CollectionSpaceKindMembershipKeys | undefined =
    'membershipKeys' in presentation ? presentation.membershipKeys : undefined;
  const formNode =
    form === null ? null : (
      <CollectionSpaceForm
        key={`${form.mode}:${selectedSpace?.id ?? ''}`}
        testIDPrefix={input.testIDPrefix}
        mode={form.mode}
        everywhereChoice={input.everywhereChoice}
        initial={
          form.mode === 'edit' && selectedSpace
            ? {
                name: selectedSpace.name,
                icon: selectedSpace.icon,
                includeNeedsYouEverywhere:
                  selectedSpace.includeNeedsYouEverywhere,
                ...(membershipKind ? { membershipMode: spaceMembership?.mode ?? 'filter_or_manual' } : {}),
              }
            : { ...input.suggestion, includeNeedsYouEverywhere: false,
                ...(membershipKind ? { membershipMode: 'filter_or_manual' as const } : {}) }
        }
        suggestedIcons={[input.suggestion.icon]}
        summary={input.summary}
        {...(membershipKeys ? { membershipDescriptions: {
          smart: t(membershipKeys.smart), manual: t(membershipKeys.manual) } } : {})}
        busy={form.busy}
        error={form.error}
        // Definitions live in an Account's settings: without one there is nowhere to save (P6 §7.2).
        disabledReason={serverId && accountId ? null : t('sessionsList.spacesNeedsAccount')}
        deletion={
          form.mode === 'edit'
            ? selectedSpace?.id === defaultSpaceId
              ? 'reset'
              : 'delete'
            : undefined
        }
        onSubmit={(value) => {
          void submitForm(value);
        }}
        onCancel={closeForm}
        onDelete={() => {
          void deleteSelected();
        }}
      />
    );
  const formMode = form?.mode;
  const anchorRef = input.anchorRef;
  const formOverlay = React.useMemo(
    () => (
      <Popover
        open={formMode !== undefined}
        anchorRef={anchorRef}
        placement="bottom"
        gap={6}
        boundaryRef={null}
        edgePadding={{ horizontal: 8, vertical: 8 }}
        maxWidthCap={FORM_POPOVER_WIDTH_PX}
        autoFocusOnOpen
        portal={MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS}
        onRequestClose={closeForm}
        backdrop={false}
        phonePresentation="sheet"
        // Also the phone sheet's title: a name, not the menu item that opened it ("Save as space…").
        accessibilityLabel={
          formMode === 'edit' && selectedSpace
            ? t('sessionsList.spacesEditNamed', { name: selectedSpace.name })
            : t('sessionsList.spacesNew')
        }
        containerStyle={{ paddingHorizontal: 0 }}
      >
        {({ maxHeight }) => (
          <FloatingOverlay
            maxHeight={maxHeight}
            surfaceChrome="theme"
            scrollEnabled={false}
          >
            {formNode}
          </FloatingOverlay>
        )}
      </Popover>
    ),
    [anchorRef, closeForm, formMode, formNode],
  );

  return {
    invoke,
    selectSpace,
    reorder,
    openSaveAs,
    openEdit,
    saveChanges,
    formOverlay,
  };
}
