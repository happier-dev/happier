import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { ProjectSourceRepositorySelectorV1, ProjectSourceV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import {
  readScmHostingRepositoryIdentity,
  sameScmHostingRepositoryIdentity,
} from '@happier-dev/protocol/scm/hostingRepositoryIdentity';

import { useProjectSourceAddress } from '@/components/projects/sources/useProjectSourceAddress';
import { presentProjectSourceAddressRefusal } from '@/components/projects/sources/resolveProjectSourceAddress';
import { useProjectSources } from '@/components/projects/sources/useProjectSources';
import { presentProjectSourceIssue } from '@/components/projects/sources/projectSourceIssue';
import { isRepositoryAddressCandidate } from '@/components/projects/sources/projectSourceAddress';
import { resolveHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { describeCodeSource } from './codeSourcePresentation';
import { CompactSearchField } from '@/components/ui/forms/CompactSearchField';
import { useDeviceType } from '@/utils/platform/responsive';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import {
  SelectionTiles,
  type SelectionTile,
} from '@/components/ui/forms/SelectionTiles';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { EmptyState } from '@/components/ui/empty/EmptyState';
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
 * to a Project already here picks that Project; any other repository becomes the chosen tile, handed to the host with
 * the Sources' own save so Continue keeps it as this Home's Source and opens its new Environment (O-DEPLOY 11-15
 * 17:33Z). A link is read as it is pasted or typed. A repository-free Project holds stored definitions only, so it is
 * reached through Already built.
 */
export function NewAppCodeSources(
  props: Readonly<{
    scope: ServerAccountScope;
    value: string | null;
    onChange: (projectSourceId: string | null) => void;
    /** A pasted repository that is not a Project here yet; null when a Project or nothing is chosen. */
    chosenRepository: ProjectSourceRepositorySelectorV1 | null;
    /** `save` keeps it as a Source through the Sources' own writer; resolves to the Source, or nothing when refused. */
    onChooseRepository: (selector: ProjectSourceRepositorySelectorV1, save: () => Promise<ProjectSourceV1 | undefined>) => void;
    /** The step's one search (owned by the host): narrows these repositories, the starters and the catalog alike. */
    query: string;
    onQueryChange: (query: string) => void;
    /** Two per line in the dialog (owner 11-14); one on a phone (rows rule). */
    columns: 1 | 2;
  }>,
): React.ReactNode {
  const { state, controller, repositoryFacts } = useProjectSources(props.scope, { repositoryFacts: true });
  const [saveIssue, setSaveIssue] = React.useState<string | null>(null);
  const rows = state.rows ?? NO_ROWS;
  const withCode = React.useMemo(
    () => rows.filter((row) => row.repository !== undefined),
    [rows],
  );
  const { query, onQueryChange: setQuery } = props;
  const address = useProjectSourceAddress(props.scope, (selector) => {
    const identity = identityOf(selector);
    const project = withCode.find((row) => sameScmHostingRepositoryIdentity(identityOf(row.repository!), identity));
    if (project) {
      setQuery('');
      props.onChange(project.id);
    } else {
      setSaveIssue(null);
      props.onChooseRepository(selector, async () => {
        controller.beginCreate({ repository: selector });
        const source = await controller.save();
        setSaveIssue(source ? null : controller.getSnapshot().issue ?? 'source_save_failed');
        return source ?? undefined;
      });
    }
  });
  const askedMachineId = address.resolution.kind === 'resolving' || address.resolution.kind === 'unavailable'
    ? address.resolution.machineId ?? null : null;
  const askedMachine = useServerScopedMachineLabel(props.scope.serverId, askedMachineId);
  const devicePhone = useDeviceType() === 'phone';
  // A submitted search that is not an address is only a search: it never reads as a refused link.
  const refusal = address.refusal && address.refusal !== 'projects.sources.loading'
    && address.refusal !== 'projects.sources.addressInvalid'
    ? presentProjectSourceAddressRefusal(address.resolution, address.refusal, () => askedMachine ?? '')
    : null;
  const reading = address.resolution.kind === 'resolving'
    ? t('projects.sources.addressResolving', { machine: askedMachine ?? '' }) : null;
  const saveBanner = saveIssue && props.chosenRepository ? presentProjectSourceIssue(saveIssue,
    resolveHomeDisplayLabel(getServerProfileById(props.scope.serverId), props.scope.serverId)) : null;
  // A link is read, not searched for: the repositories stay listed while it is checked.
  const needle = isRepositoryAddressCandidate(query) ? '' : query.trim().toLowerCase();
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
        subtitle: pasted.provider.displayName,
        icon: 'git-branch' as const,
      }] : []),
      ...shown.map((row) => ({
        id: row.id,
        title: row.name,
        subtitle: describeCodeSource({ nameWithOwner: row.repository!.repository.nameWithOwner,
          provider: row.repository!.provider.displayName }, repositoryFacts.get(row.id)),
        icon: 'git-branch' as const,
      })),
    ],
    [pasted, repositoryFacts, shown],
  );
  return (
    <>
      {/* The search leads the step (lab f1src), on the same edge as the sections' tiles beneath it. */}
      <ItemGroup testID="newApp.search" header="none" surface="none">
      <View style={styles.field}>
        {/* The app's one search field; a pasted or typed repository link is read as it lands (Enter reads it at once). */}
        <CompactSearchField
          testID="newApp.code.address"
          value={query}
          onChangeText={(text) => {
            setQuery(text);
            address.withdrawRefusal();
            address.resolveAsTyped(text);
          }}
          onSubmitEditing={() => {
            if (query.trim()) void address.resolve(query.trim());
          }}
          // The lab's sentence on wide; a phone's field holds the short one whole (QA #34, 320).
          placeholder={t(props.columns === 1 ? 'newApp.codeSearchPlaceholderShort' : 'newApp.codeSearchPlaceholder')}
          // Deploy an app opens on its search, where the person starts (PAGE-ACCEPT-176 R11-D10); a phone keeps
          // its keyboard down until the field is touched, as the describe step does.
          autoFocus={!devicePhone}
        />
        {reading ? <EmptyState testID="newApp.code.address.reading" layout="line" lineLoading title={reading} /> : null}
        {refusal ? (
          <SurfaceStateCard testID="newApp.code.address.refusal" size="line" kind="unavailable" title={refusal} />
        ) : null}
        {saveBanner ? (
          <SurfaceStateCard testID="newApp.code.saveIssue" size="line" kind="error" title={saveBanner.title} />
        ) : null}
      </View>
      </ItemGroup>
      {tiles.length > 0 || (needle && withCode.length > 0) ? (
    <ItemGroup testID="newApp.code" title={t('newApp.yourCode')} titleRole="label" surface="none">
      <View style={styles.column}>
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
          <EmptyState testID="newApp.code.noMatch" layout="line" title={t('newApp.codeNoMatch')} />
        ) : null}
      </View>
    </ItemGroup>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  column: { gap: theme.space.s8 },
  field: { paddingTop: theme.space.s8, gap: theme.space.s8 },
}));
