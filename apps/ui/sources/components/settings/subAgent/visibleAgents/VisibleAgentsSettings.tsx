import * as React from 'react';
import {
    DEFAULT_TEAM_TEMPLATE_V1,
    ExecutionRunRoleSchema,
} from '@happier-dev/protocol';

import type { ResolvedBackendCatalogEntry } from '@/agents/backendCatalog/getResolvedBackendCatalogEntries';
import { resolveAssignableSessionRoleProfileDisplayName } from '@/components/sessions/roles/sessionRoleLabels';
import { listUiAssignableSessionRoleProfiles } from '@/components/sessions/roles/sessionRoleProfileOrder';
import { storage, useSetting, useSettingMutable } from '@/sync/domains/state/storage';

import { showVisibleAgentsTeamTemplateEditorModal } from './showVisibleAgentsTeamTemplateEditorModal';
import {
    parseVisibleAgentsSettingV1,
    updateVisibleAgentsAssemblyEnabledV1,
    updateVisibleAgentsTeamTemplateV1,
} from './visibleAgentsSettingsState';
import { VisibleAgentsSettingsGroup } from './VisibleAgentsSettingsGroup';

export function VisibleAgentsSettings(props: Readonly<{
    backendEntries: ReadonlyArray<ResolvedBackendCatalogEntry>;
}>) {
    const [setting, setSetting] = useSettingMutable('visibleAgentsV1');
    const sessionRoleProfilesV1 = useSetting('sessionRoleProfilesV1');
    const parsed = React.useMemo(() => parseVisibleAgentsSettingV1(setting), [setting]);
    const roles = React.useMemo(() => listUiAssignableSessionRoleProfiles({ sessionRoleProfilesV1 }).flatMap((profile) => {
        const role = ExecutionRunRoleSchema.safeParse(profile.id);
        return role.success ? [{ id: role.data, label: resolveAssignableSessionRoleProfileDisplayName(profile) }] : [];
    }), [sessionRoleProfilesV1]);
    const backends = React.useMemo(() => props.backendEntries.map((entry) => ({
        target: entry.target,
        label: entry.title,
    })), [props.backendEntries]);
    const roleLabelById = React.useMemo(() => new Map(roles.map((role) => [role.id, role.label])), [roles]);

    const updateLatest = React.useCallback((update: (raw: unknown) => typeof parsed) => {
        setSetting(update(storage.getState().settings.visibleAgentsV1));
    }, [setSetting]);
    const editTeamTemplate = React.useCallback(async () => {
        const current = parseVisibleAgentsSettingV1(storage.getState().settings.visibleAgentsV1);
        const initial = current.teamTemplate && current.teamTemplate.length > 0
            ? current.teamTemplate
            : DEFAULT_TEAM_TEMPLATE_V1;
        const result = await showVisibleAgentsTeamTemplateEditorModal({ initial, roles, backends });
        if (!result) return;
        updateLatest((latest) => updateVisibleAgentsTeamTemplateV1(latest, result));
    }, [backends, roles, updateLatest]);
    const effectiveTemplate = parsed.teamTemplate && parsed.teamTemplate.length > 0
        ? parsed.teamTemplate
        : DEFAULT_TEAM_TEMPLATE_V1;
    const teamTemplateSummary = effectiveTemplate
        .map((entry) => roleLabelById.get(entry.role) ?? entry.role)
        .join(', ');

    return (
        <VisibleAgentsSettingsGroup
            assembleTeamOnLeadAssignment={parsed.assembleTeamOnLeadAssignment}
            teamTemplateSummary={teamTemplateSummary}
            onAssemblyEnabledChange={(enabled) => updateLatest((latest) => updateVisibleAgentsAssemblyEnabledV1(latest, enabled))}
            onEditTeamTemplate={() => { void editTeamTemplate(); }}
        />
    );
}
