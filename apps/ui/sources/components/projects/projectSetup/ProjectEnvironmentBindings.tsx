import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ProjectManifestV1 } from '@happier-dev/protocol/workspaces/projectSetup/projectManifestV1';

import { useSavedSecretCatalogName } from '@/components/secrets/useSavedSecretCatalog';
import { IconButton } from '@/components/ui/buttons/IconButton';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { t } from '@/text';

import type { ProjectEnvironmentBindingsController } from './useProjectEnvironmentBindings';

type Props = Readonly<{
  testID: string;
  manifest: ProjectManifestV1;
  controller: ProjectEnvironmentBindingsController;
  /** Failed Run recovery offers the same Project binding edits in the task's context. */
  recovery?: boolean;
}>;

/** Project-scoped references only. The existing catalog/picker never acquires Secret values here. */
export function ProjectEnvironmentBindings(props: Props) {
  const requirements = props.manifest.environmentVariables?.filter(requirement => requirement.kind === 'secret') ?? [];
  const names = [...new Set([...requirements.map(requirement => requirement.name),
    ...(props.recovery ? [] : Object.keys(props.controller.bindings ?? {}))])];
  if (names.length === 0) return null;
  return (
    <ItemGroup
      title={t('projects.scripts.environment.title')}
      description={t(props.recovery ? 'projects.scripts.environment.recovery' : 'projects.scripts.environment.description')}
      testID={props.testID}
    >
      {props.controller.status !== 'ready' ? (
        <SurfaceStateCard size="line" kind={props.controller.status === 'loading' ? 'loading' : 'unavailable'}
          title={t(props.controller.status === 'loading' ? 'common.loading' : 'projects.scripts.environment.unavailable')} />
      ) : null}
      {names.map((name, index) => (
        <ProjectEnvironmentBindingRow key={name} name={name} testID={`${props.testID}.${name}`}
          required={requirements.find(requirement => requirement.name === name)?.required}
          controller={props.controller} showDivider={index < names.length - 1} />
      ))}
    </ItemGroup>
  );
}

function ProjectEnvironmentBindingRow(props: Readonly<{
  testID: string; name: string; required?: boolean; showDivider: boolean;
  controller: ProjectEnvironmentBindingsController;
}>) {
  const reference = props.controller.bindings?.[props.name];
  const label = useSavedSecretCatalogName(reference?.ref ?? null, props.controller.scope);
  const pending = props.controller.pendingName === props.name;
  const error = props.controller.error?.name === props.name ? props.controller.error.code : null;
  return (
    <>
      <Item testID={props.testID} title={props.name}
        subtitle={[props.required === undefined ? null : t(props.required ? 'projects.scripts.environment.required' : 'projects.scripts.environment.optional'),
          label.name ?? reference?.ref].filter(Boolean).join(' · ')}
        showChevron={false} showDivider={props.showDivider} accessoryLayout="adaptive"
        rightElement={(
          <View style={styles.controls}>
            <RoundButton testID={`${props.testID}.choose`} size="small" display="secondary"
              title={t(reference ? 'projects.scripts.environment.change' : 'projects.scripts.environment.choose')}
              accessibilityLabel={t(reference ? 'projects.scripts.environment.changeNamed' : 'projects.scripts.environment.chooseNamed', { name: props.name })}
              loading={pending} disabled={!props.controller.available || props.controller.pendingName !== null}
              onPress={() => { void props.controller.choose(props.name); }} />
            {reference ? <IconButton testID={`${props.testID}.remove`} iconName="x" variant="plain"
              accessibilityLabel={t('projects.scripts.environment.removeNamed', { name: props.name })}
              disabled={!props.controller.available || props.controller.pendingName !== null}
              onPress={() => { void props.controller.remove(props.name); }} /> : null}
          </View>
        )} />
      {error ? <SurfaceStateCard testID={`${props.testID}.error`} size="line" kind="unavailable"
        title={t('projects.scripts.environment.saveFailed')} diagnosticCode={error} /> : null}
    </>
  );
}

const styles = StyleSheet.create(theme => ({
  controls: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s2 },
}));

