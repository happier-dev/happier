import * as React from 'react';
import type { SessionSpaceMembershipTargetV1 } from '@happier-dev/protocol/actions';
import type { SessionExecutionTargetV1} from '@happier-dev/protocol/sessions/creation/sessionExecutionTargetV1';
import type { SessionOrganizationPlacementV1 } from '@happier-dev/protocol/sessions/creation/sessionSpawnNewResultV1';
import { useUnistyles } from 'react-native-unistyles';
import { createDefaultCollectionSpaceV1 } from '@happier-dev/protocol/collections/spaces/collectionSpacesV1';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSessionOrganizationProjection } from '@/sync/domains/state/storage';
import { buildSessionOrganizationListViewState } from '@/sync/domains/session/organization/viewState';
import { buildSessionOrganizationTagLabelById } from '@/sync/domains/session/organization/tagLabels';
import { resolveSessionSectionChoiceLabel, type SectionAddress, type SessionSection } from '@/sync/domains/session/organization';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { areServerAccountScopesEqual, type ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { areServerProfileIdentifiersEquivalent, resolveServerProfileScopeIdForIdentifier } from '@/sync/domains/server/serverProfiles';
import {
    createSessionOrganizationTagWithLabel,
    requireSessionOrganizationMutationScope,
} from '@/sync/ops/sessionOrganization';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { AgentInputExtraActionChip } from '@/components/sessions/agentInput/agentInputContracts';
import { HappyError } from '@/utils/errors/errors';
import { useCollectionSpaceBinding } from '@/components/ui/lists/collection/useCollectionSpaceBinding';

import {
    isNewSessionOrganizationPlacementAvailable,
    normalizeNewSessionOrganizationPlacement,
    reconcileNewSessionOrganizationPlacementForAccount,
} from './newSessionOrganizationPlacementState';
import { createNewSessionOrganizationPlacementActionChips, type NewSessionSpaceChoice } from './newSessionOrganizationPlacementActionChips';

const DEFAULT_SESSION_SPACE_FILTER = createDefaultCollectionSpaceV1('sessionWork').filter;

export function useNewSessionOrganizationPlacement(params: Readonly<{
    /** The selected Account/Home is independent of execution placement. */
    serverId: string | null;
    executionTarget: SessionExecutionTargetV1 | null;
    directory: string;
    /** `managed`: a no-folder draft, placed in its machine's Chats scope. */
    directoryKind?: 'path' | 'managed';
    initialPlacement?: SessionOrganizationPlacementV1 | null;
    initialSpaceMembership?: SessionSpaceMembershipTargetV1 | null;
    /**
     * An ordinary entry with no recorded Space choice starts in the Space it was opened in. This is entry
     * context, not authored content: it reaches the draft with the first authored edit (authoring autosave)
     * and the launch, so an untouched New Session never becomes a stored draft.
     */
    startInActiveSpace?: boolean;
    /** Retained placement never acquires a different Home from its execution draft. */
    initialPlacementServerId?: string | null;
    /** Existing Account-keyed draft custody, when its originating Account is known. */
    initialPlacementScope?: ServerAccountScope | null;
    /** Retained recipes preserve authored placement; availability is Account-scoped. */
    reconcileWorkspace?: boolean;
}>): Readonly<{
    enabled: boolean;
    valid: boolean;
    placement: SessionOrganizationPlacementV1;
    spaceMembership: SessionSpaceMembershipTargetV1 | null;
    setSpaceMembership: (next: SessionSpaceMembershipTargetV1 | null) => void;
    /** Captured identity; a foreign retained selection is never relabeled as a local same-id section. */
    selectedSectionAddress: SectionAddress | null;
    sectionSelectionValid: boolean;
    sections: readonly SessionSection[];
    setSectionAddress: (next: SectionAddress | null) => void;
    /** Readable sections in the chosen Account, for hosts that present a placement field. */
    folderTargets: readonly Readonly<{ folderId: string; title: string; depth: number }>[];
    actionChips: readonly AgentInputExtraActionChip[];
    setFolderId: (folderId: string | null) => void;
    setTagIds: (tagIds: readonly string[]) => void;
}> {
    const { theme } = useUnistyles();
    const spaceBinding = useCollectionSpaceBinding('sessionWork', {
        defaultName: t('sessionsList.filtersMyWork'), defaultFilter: DEFAULT_SESSION_SPACE_FILTER,
    });
    const { activeSpace, spacesReady, spaceSettingsScope } = spaceBinding;
    const entrySpace = React.useMemo((): SessionSpaceMembershipTargetV1 | null => activeSpace && spaceSettingsScope
        ? { spaceId: activeSpace.id, spaceSettingsTarget: spaceSettingsScope } : null, [activeSpace, spaceSettingsScope]);
    const [spaceMembership, setSpaceMembershipState] = React.useState((): SessionSpaceMembershipTargetV1 | null => (
        params.initialSpaceMembership !== undefined ? params.initialSpaceMembership
            : params.startInActiveSpace ? entrySpace : null
    ));
    // An entry opened before the Account's Space settings were readable takes its Space once they are,
    // unless the person chose first; afterwards later sidebar switches never move it.
    const awaitingEntrySpaceRef = React.useRef(params.startInActiveSpace === true
        && params.initialSpaceMembership === undefined && entrySpace === null && !spacesReady);
    React.useEffect(() => {
        if (!awaitingEntrySpaceRef.current || (!entrySpace && !spacesReady)) return;
        awaitingEntrySpaceRef.current = false;
        if (entrySpace) setSpaceMembershipState(entrySpace);
    }, [entrySpace, spacesReady]);
    const setSpaceMembership = React.useCallback((next: SessionSpaceMembershipTargetV1 | null) => {
        awaitingEntrySpaceRef.current = false;
        setSpaceMembershipState(next);
    }, []);
    const serverId = resolveServerProfileScopeIdForIdentifier(params.serverId);
    const enabled = useFeatureEnabled('sessions', serverId
        ? { scopeKind: 'spawn', serverId }
        : { scopeKind: 'main_selection' });
    const projection = useSessionOrganizationProjection(serverId);
    const { binding } = useServerCredentialAccountScopeBinding(serverId || null);
    const viewState = React.useMemo(() => buildSessionOrganizationListViewState({ serverId, projection }), [projection, serverId]);
    const sections = viewState.sections;
    const folderTargets = React.useMemo(
        () => sections.flatMap(section => section.display.status === 'available'
            ? [{ folderId: section.address.sectionId, title: resolveSessionSectionChoiceLabel(section, {
                unavailableLabel: t('common.unavailable'),
            }).choiceLabel, depth: 0 }]
            : []),
        [sections],
    );
    const placementTargets = React.useMemo(() => folderTargets.map(folder => ({ folderId: folder.folderId, serverId })),
        [folderTargets, serverId]);
    const tags = React.useMemo(() => {
        const labels = buildSessionOrganizationTagLabelById(projection?.tagsById ?? {});
        return Object.entries(labels).map(([id, label]) => ({ id, label }));
    }, [projection]);
    const [selection, setSelection] = React.useState(() => {
        const placementServerId = resolveServerProfileScopeIdForIdentifier(
            params.initialPlacementServerId ?? params.initialPlacementScope?.serverId ?? serverId,
        );
        return {
            placement: normalizeNewSessionOrganizationPlacement(params.initialPlacement),
            scope: params.initialPlacementScope ?? (placementServerId === serverId ? binding?.scope ?? null : null),
            serverId: placementServerId,
        };
    });
    const { placement } = selection;
    const selectedSectionAddress = React.useMemo(() => placement.folderId === null ? null : {
        serverId: selection.serverId, sectionId: placement.folderId,
    }, [placement.folderId, selection.serverId]);
    React.useEffect(() => {
        if (!binding) return;
        setSelection(current => {
            // Hydration binds the authored selection once. Later Account or Home
            // changes keep the draft visible but invalid until explicitly selected.
            if (current.scope || current.serverId !== binding.serverId) return current;
            return { ...current, scope: binding.scope };
        });
    }, [binding]);

    const changePlacement = React.useCallback((update: (current: SessionOrganizationPlacementV1) => SessionOrganizationPlacementV1) => {
        setSelection(current => ({ placement: normalizeNewSessionOrganizationPlacement(update(
            areServerAccountScopesEqual(current.scope, binding?.scope)
                ? current.placement : { folderId: null, tagIds: [] },
        )), scope: binding?.scope ?? null, serverId }));
    }, [binding, serverId]);
    const setFolderId = React.useCallback((folderId: string | null) => {
        changePlacement(current => ({ ...current, folderId }));
    }, [changePlacement]);
    const setSectionAddress = React.useCallback((next: SectionAddress | null) => {
        if (next !== null && !areServerProfileIdentifiersEquivalent(next.serverId, serverId)) return;
        setFolderId(next?.sectionId ?? null);
    }, [serverId, setFolderId]);
    const setTagIds = React.useCallback((tagIds: readonly string[]) => {
        changePlacement(current => ({ ...current, tagIds: [...tagIds] }));
    }, [changePlacement]);
    const toggleTagId = React.useCallback((tagId: string) => {
        changePlacement(current => ({ ...current,
            tagIds: current.tagIds.includes(tagId) ? current.tagIds.filter(candidate => candidate !== tagId) : [...current.tagIds, tagId],
        }));
    }, [changePlacement]);
    const createTag = React.useCallback((label: string) => {
        void (async () => {
            if (!binding?.isCurrent()) return;
            const scope = await requireSessionOrganizationMutationScope(serverId);
            if (!binding.isCurrent()) return;
            const tag = await createSessionOrganizationTagWithLabel({
                credentials: scope.credentials,
                serverId: scope.serverId,
                serverUrl: scope.serverUrl,
                label,
            });
            if (binding?.isCurrent()) changePlacement(current => ({ ...current, tagIds: [...current.tagIds, tag.tagId] }));
        })().catch((error: unknown) => {
            Modal.alert(
                t('common.error'),
                error instanceof HappyError ? error.message : t('errors.unknownError'),
            );
        });
    }, [binding, changePlacement, serverId]);
    // Spaces off: no picker, unless the draft still carries a space, which stays visible so it can be cleared.
    const spaceTarget = spaceBinding.spaceSettingsScope;
    const spaceChoice = React.useMemo((): NewSessionSpaceChoice | undefined => {
        if (!spaceTarget || !(spaceMembership !== null || spaceBinding.spacesEnabled)) return undefined;
        return { spaces: spaceBinding.spaces, selectedSpaceId: spaceMembership?.spaceId ?? null,
            onSelect: spaceId => setSpaceMembership(spaceId === null ? null : { spaceId, spaceSettingsTarget: spaceTarget }) };
    }, [spaceBinding.spaces, spaceBinding.spacesEnabled, spaceMembership, spaceTarget]);
    const actionChips = React.useMemo(() => createNewSessionOrganizationPlacementActionChips({
        enabled,
        sectionAddress: selectedSectionAddress,
        tagIds: placement.tagIds,
        sections,
        tags,
        iconColor: theme.colors.text.secondary,
        onSectionSelect: setSectionAddress,
        onTagToggle: toggleTagId,
        onTagCreate: createTag,
        ...(spaceChoice ? { space: spaceChoice } : {}),
    }), [createTag, enabled, spaceChoice, placement.tagIds, sections, selectedSectionAddress, setSectionAddress, tags, theme.colors.text.secondary, toggleTagId]);
    const valid = isNewSessionOrganizationPlacementAvailable({
        featureEnabled: enabled,
        placement,
        placementScope: selection.scope,
        targetScope: binding?.scope ?? null,
        sectionAvailable: !placement.folderId || reconcileNewSessionOrganizationPlacementForAccount({
            placement, targetServerId: serverId,
            folders: placementTargets,
        }) === placement,
    });

    return { enabled, valid, placement, spaceMembership, setSpaceMembership, selectedSectionAddress, sectionSelectionValid: placement.folderId === null || valid,
        sections, setSectionAddress, folderTargets, actionChips, setFolderId, setTagIds };
}
