import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import type { ProjectSourceRepositorySelectorV1, ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import {
  readScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
} from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

import { useProjectSourceAddress } from '@/components/projects/sources/useProjectSourceAddress';
import { presentProjectSourceAddressRefusal } from '@/components/projects/sources/resolveProjectSourceAddress';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Text } from '@/components/ui/text/Text';
import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { useServerScopedMachineLabel } from '@/sync/store/hooks';
import { t } from '@/text';

/** The repository Projects shown as tiles (lab f1src "Your code", two per line); a search names the rest. */
const SHOWN = 4;
const PASTED = 'pasted';
const NO_ROWS: readonly ProjectSourceV1[] = Object.freeze([]);

const identityOf = (selector: ProjectSourceRepositorySelectorV1) =>
  readScmHostingRepositoryIdentity({ ...selector.provider, nameWithOwner: selector.repository.nameWithOwner });

/**
 * Deploy an app → Your code (owner ruling 11-14 20:50Z): the Account's Projects that have a repository, a search that
 * narrows them, and a pasted GitHub or GitLab link read by a Machine's hosting owner (`useProjectSourceAddress`). A link
 * to a Project already here picks that Project; any other repository becomes the chosen tile, which the host opens as a
 * Project first. A repository-free Project holds stored definitions only, so it is reached through Already built.
 */
export function NewAppCodeSources(
  props: Readonly<{
    scope: ServerAccountScope;
    value: string | null;
    onChange: (projectSourceId: string | null) => void;
    /** A pasted repository that is not a Project here yet; null when a Project or nothing is chosen. */
    chosenRepository: ProjectSourceRepositorySelectorV1 | null;
    onChooseRepository: (selector: ProjectSourceRepositorySelectorV1) => void;
    /** Two per line in the dialog (owner 11-14); one on a phone (rows rule). */
    columns: 1 | 2;
    /** Lines the section up with the gallery beneath it inside the dialog card. */
    insetStyle: React.ComponentProps<typeof View>['style'];
  }>,
): React.ReactNode {
  const { theme } = useUnistyles();
  const { state } = useProjectSources(props.scope);
  const rows = state.rows ?? NO_ROWS;
  const withCode = React.useMemo(
    () => rows.filter((row) => row.repository !== undefined),
    [rows],
  );
  const [query, setQuery] = React.useState('');
  const address = useProjectSourceAddress(props.scope, (selector) => {
    const identity = identityOf(selector);
    const project = withCode.find((row) => sameScmHostingRepositoryIdentity(identityOf(row.repository!), identity));
    if (project) {
      setQuery('');
      props.onChange(project.id);
    } else props.onChooseRepository(selector);
  });
  const askedMachineId = address.resolution.kind === 'resolving' || address.resolution.kind === 'unavailable'
    ? address.resolution.machineId ?? null : null;
  const askedMachine = useServerScopedMachineLabel(props.scope.serverId, askedMachineId);
  // A submitted search that is not an address is only a search: it never reads as a refused link.
  const refusal = address.refusal && address.refusal !== 'projects.sources.loading'
    && address.refusal !== 'projects.sources.addressInvalid'
    ? presentProjectSourceAddressRefusal(address.resolution, address.refusal, () => askedMachine ?? '')
    : null;
  const needle = query.trim().toLowerCase();
  const matching = React.useMemo(() => needle
    ? withCode.filter((row) => row.name.toLowerCase().includes(needle)
      || row.repository!.repository.nameWithOwner.toLowerCase().includes(needle))
    : withCode, [needle, withCode]);
  // The chosen Project keeps its tile whatever the search, so the choice is always visible and selected.
  const shown = React.useMemo(() => {
    const head = matching.slice(0, SHOWN);
    const chosen = props.value ? (withCode.find((row) => row.id === props.value) ?? null) : null;
    return chosen && !head.includes(chosen) ? [...head.slice(0, SHOWN - 1), chosen] : head;
  }, [matching, props.value, withCode]);
  const pasted = props.chosenRepository;
  const tiles = React.useMemo(
    (): Array<SelectionTile<string>> => [
      ...(pasted ? [{
        id: PASTED,
        title: pasted.repository.nameWithOwner,
        subtitle: t('newApp.pastedSubtitle', { provider: pasted.provider.displayName }),
        icon: 'git-branch' as const,
      }] : []),
      ...shown.map((row) => ({
        id: row.id,
        title: row.name,
        subtitle: t('newApp.codeSubtitle', {
          repository: row.repository!.repository.nameWithOwner,
          provider: row.repository!.provider.displayName,
        }),
        icon: 'git-branch' as const,
      })),
    ],
    [pasted, shown],
  );
  return (
    <ItemGroup testID="newApp.code" title={t('newApp.yourCode')} surface="none">
      <View style={[styles.column, props.insetStyle]}>
        <FieldTextInput
          testID="newApp.code.address"
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            address.withdrawRefusal();
          }}
          onSubmitEditing={() => {
            if (query.trim()) void address.resolve(query.trim());
          }}
          placeholder={t('newApp.codeSearchPlaceholder')}
          accessibilityLabel={t('newApp.codeSearchPlaceholder')}
          autoCapitalize="none"
          returnKeyType="search"
          leading={<Icon name="magnifying-glass" size={ICON_SIZE.sm} color={theme.colors.text.secondary} />}
          error={refusal}
        />
        {tiles.length > 0 ? (
          <SelectionTiles
            testIdPrefix="newApp.code"
            accessibilityLabel={t('newApp.yourCode')}
            density="compact"
            maximumColumns={props.columns}
            subtitleLines={1}
            value={pasted ? PASTED : props.value}
            onChange={(id) => {
              if (id !== PASTED) props.onChange(id);
            }}
            options={tiles}
          />
        ) : needle && withCode.length > 0 ? (
          <Text testID="newApp.code.noMatch" variant="meta" style={{ color: theme.colors.text.secondary }}>
            {t('newApp.codeNoMatch')}
          </Text>
        ) : null}
      </View>
    </ItemGroup>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: { gap: theme.space.s8 },
}));
