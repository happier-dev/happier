import * as React from 'react';
import type { DeploymentEnvironmentContentV1, DeploymentEnvironmentHeaderV1 } from '@happier-dev/deployments/contracts/v1';
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

/** Overview reads the current definition; Settings remains the one editor and Move owner. */
/**
 * The Overview's one Definition section (PAGE-ACCEPT-176 R13-D4, lab rdEnv-envOv): one Compose file row, a Compare row
 * when the deployed revision differs (it opens the serving receipt, where the deployed document and the diff live), and
 * what a repository would add as a row of its own, with Move… as its action.
 */
export function StoredDefinitionOverview(props: Readonly<{
  revision: number;
  /** The serving receipt's revision, once known; a different one offers Compare. */
  deployedRevision: number | null;
  editable: boolean;
  onOpen: () => void;
  onCompare: () => void;
  onMove: (() => void) | null;
}>) {
  const deployedDiffers = props.deployedRevision !== null && props.deployedRevision !== props.revision;
  return (
    <ItemGroup testID="project-deployments.environment.definition"
      title={t('projects.deployments.overviewStatus.definitionTitle')}
      description={t('projects.deployments.overviewStatus.definitionStoredDescription', { revision: props.revision })}
      action={<SectionActionButton testID="project-deployments.environment.definition.edit"
        title={t(props.editable ? 'common.edit' : 'common.open')} onPress={props.onOpen} />}>
      <Item title={t('projects.deployments.composeFile')} onPress={props.onOpen} />
      {deployedDiffers ? <Item testID="project-deployments.environment.definition.compare"
        title={t('projects.scripts.definition.compare')}
        subtitle={t('projects.deployments.review.versionStored', { revision: props.deployedRevision! })}
        onPress={props.onCompare} /> : null}
      <Item testID="project-deployments.environment.definition.repositoryRequired"
        title={t('projects.deployments.overviewStatus.definitionRepositoryRequiredTitle')}
        subtitle={t('projects.deployments.overviewStatus.definitionRepositoryRequiredBody')} subtitleLines={0}
        showChevron={false} accessoryLayout="adaptive"
        rightElement={props.onMove ? <SectionActionButton testID="project-deployments.environment.definition.move"
          title={t('projects.deployments.overviewStatus.definitionMoveOpen')} onPress={props.onMove} /> : undefined} />
    </ItemGroup>
  );
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
