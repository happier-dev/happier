import * as React from 'react';
import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SectionActionButton } from '@/components/ui/lists/SectionActionButton';
import { t } from '@/text';
import type { DeploymentEnvironmentEditing } from './DeploymentEnvironmentSettingsPanel';
import type { useDeploymentChangePress } from './deploymentActionOutcome';
import { storedComposeDocumentText } from './storedComposeDocumentText';

type StoredDefinition = Extract<DeploymentEnvironmentContentV1['definition'], { kind: 'stored' }>;
export type StoredDefinitionDocument = Readonly<{ document: string; change: (document: string) => void }>;

/** The page owns typing across tab changes; a newly loaded document supplies the next editing base. */
export function useStoredDefinitionDocument(environmentId: string, definition: DeploymentEnvironmentContentV1['definition'] | undefined): StoredDefinitionDocument {
  // People edit the file as they read it: a document stored as JSON opens as YAML (the receipt shows the same text).
  const stored = definition?.kind === 'stored' ? definition.document : null;
  const base = React.useMemo(() => (stored === null ? '' : storedComposeDocumentText(stored)), [stored]);
  const [draft, setDraft] = React.useState<Readonly<{ environmentId: string; base: string; document: string }> | null>(null);
  return { document: draft?.environmentId === environmentId && draft.base === base ? draft.document : base,
    change: document => setDraft({ environmentId, base, document }) };
}

/** Only Save crosses the incumbent update Action; selectors and sidecar files retain their owner. */
export function StoredDefinitionEditor(props: Readonly<{
  environment: DeploymentEnvironmentHeaderV1;
  definition: StoredDefinition;
  document: StoredDefinitionDocument;
  editing: DeploymentEnvironmentEditing | null;
  change: ReturnType<typeof useDeploymentChangePress>;
}>) {
  const { definition, editing, change } = props;
  const document = props.document.document;
  const readable = React.useMemo(() => storedComposeDocumentText(definition.document), [definition.document]);
  const changed = document !== readable;
  return <ItemGroup testID="project-deployments.definition"
    // Section names the concept; the row names the file, so "Compose file" is said once (lab stored/overview).
    title={t('projects.deployments.overviewStatus.definitionTitle')}
    description={t('projects.deployments.overviewStatus.definitionStoredDescription', { revision: definition.contentRevision })}
    action={editing ? <SectionActionButton testID="project-deployments.definition.save" title={t('common.save')}
      loading={change.running} disabled={change.running || !changed || document.trim().length === 0}
      onPress={() => change.press(() => editing.actions.updateEnvironment(props.environment, {
        definition: { from: 'compose', document, profiles: definition.profiles, services: definition.services,
          ...(definition.primaryService ? { primaryService: definition.primaryService } : {}),
          ...(definition.publicFiles ? { publicFiles: definition.publicFiles } : {}) },
      }))} /> : undefined}>
    <Item title={t('projects.deployments.composeFile')} accessoryLayout="stacked" showChevron={false}
      rightElement={<FieldTextInput testID="project-deployments.definition.document"
        accessibilityLabel={t('projects.deployments.composeFile')} value={document} onChangeText={props.document.change}
        editable={editing !== null && !change.running} multiline growWithText monospace
        autoCapitalize="none" autoComplete="off" />} />
    {editing && changed ? <Item title={t('common.cancel')} testID="project-deployments.definition.cancel"
      disabled={change.running} onPress={() => props.document.change(readable)} /> : null}
  </ItemGroup>;
}
