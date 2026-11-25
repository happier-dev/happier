import * as React from 'react';
import type { DeploymentEnvironmentReadDetailV1 } from '@happier-dev/deployments';
import {
    DatabaseAgentLevelV1Schema,
    DeploymentEnvironmentDataEditorModeV1Schema,
    deploymentEnvironmentPrincipalKeyV1,
    type DatabaseAgentLevelV1,
} from '@happier-dev/protocol/deployments/deploymentEnvironmentDeployerV1';
import type { PrincipalRefV1 } from '@happier-dev/protocol/teams/principal';
import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { useProjectSource } from '@/components/projects/sources/useProjectSources';
import { DropdownMenu } from '@/components/ui/forms/dropdown/DropdownMenu';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import type { ServerAccountScopeLifetime } from '@/sync/domains/scope/serverAccountScope';
import { t } from '@/text';
import { DeploymentEnvironmentPeople, deployersLabel } from './DeploymentDeployerFields';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import type { useDeploymentChangePress } from './deploymentActionOutcome';
import { deploymentEnvironmentRoute } from './deploymentNavigation';

const section = 'database-access';
const testID = 'project-deployments.environment.settings.database-access';
const copy = 'projects.deployments.settingsSections.databaseAccess';
const noEditors: readonly PrincipalRefV1[] = [];
type Environment = DeploymentEnvironmentReadDetailV1['environment'];
type Patch = NonNullable<Parameters<DeploymentEnvironmentEditing['actions']['updateEnvironment']>[1]>;

export function DeploymentDatabaseAccessSettings(props: Readonly<{
    environment: Environment;
    lifetime: ServerAccountScopeLifetime | null;
    editing: DeploymentEnvironmentEditing | null;
    change: ReturnType<typeof useDeploymentChangePress>;
    outcome: React.ReactNode;
    environmentTitle: (id: string) => string | null;
}>) {
    const router = useRouter();
    const { environment } = props;
    const templateId = environment.previewTemplateEnvironmentId;
    if (templateId) {
        return <ItemGroup testID={testID} title={t(`${copy}.title`)}>
            <Item title={t(`${copy}.inherited`)} subtitle={props.environmentTitle(templateId) ?? undefined}
                onPress={() => router.pushRetainingCurrent(deploymentEnvironmentRoute({
                    serverId: environment.serverId, projectSourceId: environment.projectSourceId,
                    environmentId: templateId, tab: 'settings', section,
                }))} />
        </ItemGroup>;
    }
    return <DatabaseAccessForm key={environment.id} {...props} />;
}

function DatabaseAccessForm({ environment, lifetime, editing, change, outcome }: Omit<React.ComponentProps<typeof DeploymentDatabaseAccessSettings>, 'environmentTitle'>) {
    const [draft, setDraft] = React.useState<Pick<Patch, 'dataEditorMode' | 'dataEditors' | 'dataAgentAccess'>>({});
    const currentMode = environment.dataEditorMode ?? 'off';
    const currentLevel = environment.dataAgentAccess ?? 'read';
    const currentEditors = environment.dataEditors ?? noEditors;
    const mode = draft.dataEditorMode ?? currentMode;
    const level = draft.dataAgentAccess ?? currentLevel;
    const editors = draft.dataEditors ?? currentEditors;
    const editable = editing !== null;
    const choosePeople = editable && mode === 'chosen';
    const source = useProjectSource(choosePeople ? lifetime : null, choosePeople ? environment.projectSourceId : null).source?.source ?? null;
    const editorLabel = deploymentDatabaseEditorsLabel;
    const modeOptions = DeploymentEnvironmentDataEditorModeV1Schema.options.map(id => ({ id, label: editorLabel(id) }));
    // Four long levels: the field select the workbench access sheet uses for the same choice (one concept, one control).
    const agentItems = DatabaseAgentLevelV1Schema.options.map(id => ({ id, title: deploymentDatabaseAgentLevelLabel(id) }));
    const [agentsOpen, setAgentsOpen] = React.useState(false);
    const disabled = change.running || change.banner.pending;
    const savedKeys = new Set(currentEditors.map(deploymentEnvironmentPrincipalKeyV1));
    const editorsChanged = editors.length !== savedKeys.size || editors.some(editor => !savedKeys.has(deploymentEnvironmentPrincipalKeyV1(editor)));
    const patch: Patch = {
        ...(mode !== currentMode ? { dataEditorMode: mode } : {}),
        ...(mode === 'chosen' && editorsChanged ? { dataEditors: [...editors] } : {}),
        ...(level !== currentLevel ? { dataAgentAccess: level } : {}),
    };
    async function save() {
        if (!editing || disabled || !Object.keys(patch).length) return;
        const ok = await change.press(() => editing.actions.updateEnvironment(environment, patch), section);
        if (ok) setDraft({});
    }
    return <ItemGroup testID={testID} title={t(`${copy}.title`)}
        action={editable ? <SectionActionButton testID={`${testID}.save`} title={t('common.save')}
            disabled={disabled || !Object.keys(patch).length} onPress={save} /> : undefined}>
        {outcome}
        {editable ? <SegmentedChoiceItem testIDPrefix={`${testID}.editors`} title={t(`${copy}.editors`)}
            options={modeOptions} value={mode} disabled={disabled}
            onChange={dataEditorMode => setDraft(previous => ({ ...previous, dataEditorMode }))} /> :
            <Item title={t(`${copy}.editors`)} detail={editorLabel(mode)} mode="info" />}
        {mode === 'chosen' && lifetime ? <DeploymentEnvironmentPeople scope={lifetime.scope} lifetime={lifetime}
            source={source} owner={environment.owner} principals={editors} editable={editable && !disabled} wholeTeams
            onChangePrincipals={next => setDraft(previous => ({ ...previous, dataEditors: [...next] }))} /> : null}
        {editable ? <DropdownMenu testID={`${testID}.agents`} open={agentsOpen} onOpenChange={setAgentsOpen}
            items={agentItems} selectedId={level} search={false}
            itemTrigger={{ title: t(`${copy}.agents`), itemProps: { disabled } }}
            onSelect={id => {
                setAgentsOpen(false);
                const dataAgentAccess = DatabaseAgentLevelV1Schema.options.find(option => option === id);
                if (dataAgentAccess) setDraft(previous => ({ ...previous, dataAgentAccess }));
            }} /> :
            <Item title={t(`${copy}.agents`)} detail={deploymentDatabaseAgentLevelLabel(level)} mode="info" />}
    </ItemGroup>;
}

export function deploymentDatabaseEditorsLabel(mode: NonNullable<Environment['dataEditorMode']>) {
    return mode === 'off' ? t(`${copy}.off`) : deployersLabel(mode);
}

export function deploymentDatabaseAgentLevelLabel(level: DatabaseAgentLevelV1) {
    return t(`${copy}.levels.${level}`);
}
