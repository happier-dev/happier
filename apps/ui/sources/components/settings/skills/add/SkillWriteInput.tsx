import * as React from 'react';
import { View } from 'react-native';
import { useStore } from 'zustand';
import { readSkillFrontmatterV1 } from '@happier-dev/protocol/prompts/library/skills/skillLibraryItemV1';

import { CapabilityAddDetailAction, type CapabilityAddInputContext } from '@/components/capabilities/add/CapabilityAddModal';
import { CapabilityDetailHeader } from '@/components/capabilities/detail/CapabilityDetailHeader';
import { buildCapabilityCollectionAnatomy } from '@/components/capabilities/row/buildCapabilityCollectionAnatomy';
import { WhereItsOnControl } from '@/components/capabilities/where/WhereItsOnControl';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ItemList } from '@/components/ui/lists/ItemList';
import { SurfaceStateCard } from '@/components/ui/surfaces/SurfaceStateCard';
import { Icon, ICON_SIZE } from '@/components/ui/icons/Icon';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { projectReachOnMachines } from '@/sync/domains/capabilities/reach/useReachProjection';
import { t } from '@/text';
import { SkillInstructionsSection, lintSkillMarkdown } from '../detail/SkillInstructionsSection';
import { useSkillPlaces } from '../useSkillPlaces';
import type { SkillDraft } from './useSkillDraft';

const neverSaves = async () => ({ ok: true as const, revision: '' });
const noTheirs = async () => null;
const noAdopt = async () => {};
const noDirty = () => {};

type Props = Readonly<{
  draft: SkillDraft;
  onCreated?: (id: string) => void;
  onOpen: (id: string) => void | Promise<void>;
  renderCreated?: (id: string, notice: React.ReactElement) => React.ReactElement;
  /** Inside the Add dialog: the skill's files lead the list, the file being written is the details (lab `k:write`). */
  ctx?: CapabilityAddInputContext;
  /** Inside the Add dialog, after adding: Done steps back. */
  onDone?: () => void | Promise<void>;
}>;

type DraftState = ReturnType<SkillDraft['store']['getState']>;
type SkillFile = Readonly<{ path: 'SKILL.md' }>;
const FILES: readonly SkillFile[] = [{ path: 'SKILL.md' }];

export function SkillWriteInput(props: Props) {
  const { draft } = props;
  const state = useStore(draft.store);
  if (!draft.current) return <SurfaceStateCard kind={draft.resolving ? 'loading' : 'error'} size="line"
    title={draft.resolving ? t('common.loading') : t('common.unavailable')} testID="skill.draft.unavailable" />;
  return props.ctx ? <SkillWriteFound {...props} ctx={props.ctx} state={state} /> : <SkillWriteEditor {...props} state={state} />;
}

function SkillWriteFound(props: Props & Readonly<{ ctx: CapabilityAddInputContext; state: DraftState }>) {
  const { draft, state } = props;
  const { theme } = useUnistyles();
  const lint = React.useMemo(() => lintSkillMarkdown(state.text), [state.text]);
  const anatomy = React.useMemo(() => buildCapabilityCollectionAnatomy<SkillFile>({
    title: file => file.path,
    description: () => t('capabilities.skillDetail.instructions.title'),
    mark: () => <Icon name="file-text" size={ICON_SIZE.md} color={theme.colors.text.secondary} />,
    facts: () => ({}),
    accessibilityLabel: file => `${file.path}, ${t('capabilities.skillDetail.instructions.title')}`,
    testID: () => 'skill.draft.file',
  }), [theme.colors.text.secondary]);
  const id = state.receipt?.skillIds[0] ?? null;
  const partial = id !== null && state.receipt!.incomplete.length > 0;
  // Choosing Write is choosing to write SKILL.md: its editor opens at once, and a phone's Back shows the files.
  const openDetail = React.useRef(props.ctx.openDetail);
  React.useEffect(() => { openDetail.current(FILES[0]!.path); }, []);
  return props.ctx.renderFound<SkillFile>({
    items: FILES,
    itemKey: file => file.path,
    groups: [{ key: 'files', title: t('capabilities.skillDetail.files.title'), itemKeys: FILES.map(file => file.path) }],
    anatomy,
    empty: null,
    renderDetail: () => <SkillWriteDetail draft={draft} state={state} />,
    detailFooter: () => ({
      provenance: <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('capabilities.skillDetail.files.afterAdd')}</Text>,
      primary: {
        label: t(partial ? 'capabilities.skillAdd.partial.tryAgain' : state.busy ? 'capabilities.skillDetail.draft.adding' : 'capabilities.skillDetail.draft.add'),
        busy: state.busy,
        // An invalid SKILL.md can't be added: the editor's own lint line says what to fix, the button names it too.
        ...(partial || lint.ok ? {} : { disabledReason: lint.message }),
        onPress: async () => {
          const created = await draft.create();
          if (created === null) return null;
          props.onCreated?.(created);
          return { itemId: created, then: 'stay' as const };
        },
      },
      afterAdd: {
        start: (
          <View style={styles.note} testID="skill.draft.added" accessibilityLiveRegion="polite">
            <Icon name="check" size={ICON_SIZE.xs} color={theme.colors.text.secondary} />
            <Text variant="meta" style={{ color: theme.colors.text.secondary }}>{t('capabilities.add.added')}</Text>
          </View>
        ),
        ...(id !== null && !partial ? { open: { label: t('capabilities.skillAdd.open'), onPress: () => { void props.onOpen(id); } } } : {}),
        ...(props.onDone ? { onDone: () => { void props.onDone?.(); } } : {}),
      },
    }),
  });
}

/** The file being written: identity, the action, then its instructions and where it's on (lab `k:write`). */
function SkillWriteDetail(props: Readonly<{ draft: SkillDraft; state: DraftState }>) {
  const { draft, state } = props;
  const frontmatter = React.useMemo(() => readSkillFrontmatterV1(state.text), [state.text]);
  return <View>
    <CapabilityDetailHeader testID="skill.draft.header"
      title={frontmatter.name?.trim() || t('capabilities.skillDetail.draft.title')}
      purpose={t('capabilities.skillDetail.draft.purpose')} facts={{ source: { kind: 'you' } }} />
    <CapabilityAddDetailAction />
    {state.error ? <SurfaceStateCard testID="skill.draft.partial" kind="error" size="line" title={state.error} /> : null}
    <SkillWriteSections draft={draft} state={state} />
  </View>;
}

function SkillWriteEditor(props: Props & Readonly<{ state: DraftState }>) {
  const { draft, state } = props;
  const { theme } = useUnistyles();
  const lint = React.useMemo(() => lintSkillMarkdown(state.text), [state.text]);
  const frontmatter = React.useMemo(() => readSkillFrontmatterV1(state.text), [state.text]);
  const add = async () => {
    const id = await draft.create();
    if (id) props.onCreated?.(id);
  };
  const notice = <SurfaceStateCard testID="skill.draft.partial" kind="error" size="line" title={state.error ?? t('capabilities.skillDetail.draft.addFailed')}
    action={{ label: t('capabilities.skillAdd.partial.tryAgain'), busy: state.busy, onPress: add }} />;
  const id = state.receipt?.skillIds[0];
  if (id && state.receipt!.incomplete.length > 0 && props.renderCreated) return props.renderCreated(id, notice);
  return <ItemList keyboardShouldPersistTaps="handled">
    <CapabilityDetailHeader testID="skill.draft.header"
      title={frontmatter.name?.trim() || t('capabilities.skillDetail.draft.title')}
      purpose={t('capabilities.skillDetail.draft.purpose')} facts={{ source: { kind: 'you' } }}
      primaryAction={id && state.receipt!.incomplete.length === 0 ? {
        testID: 'skill.draft.open', title: t('capabilities.skillAdd.open'), onPress: () => props.onOpen(id),
      } : { testID: 'skill.draft.add', title: t(id ? 'capabilities.skillAdd.partial.tryAgain' : state.busy ? 'capabilities.skillDetail.draft.adding' : 'capabilities.skillDetail.draft.add'),
        onPress: add, disabled: !lint.ok || state.busy, loading: state.busy }} />
    {state.error ? notice : null}
    {id ? state.receipt!.incomplete.length === 0 ? <SurfaceStateCard kind="empty" size="line" title={t('capabilities.add.added')} testID="skill.draft.added" /> : null : <>
      <SkillWriteSections draft={draft} state={state} />
      <ItemGroup title={t('capabilities.skillDetail.files.title')} description={t('capabilities.skillDetail.files.afterAdd')} density="compact">
        <Item testID="skill.draft.file" title="SKILL.md" titleStyle={Typography.mono()}
          icon={<Icon name="file-text" size={18} color={theme.colors.text.secondary} />} showChevron={false} />
      </ItemGroup>
    </>}
  </ItemList>;
}

/** The instructions, then where the skill is on; both hold still while its add is pending or once it landed. */
function SkillWriteSections(props: Readonly<{ draft: SkillDraft; state: DraftState }>) {
  const { draft, state } = props;
  const places = useSkillPlaces();
  const editorDraft = React.useMemo(() => ({ text: state.text, onChange: draft.changeText }), [draft.changeText, state.text]);
  const projection = React.useMemo(() => projectReachOnMachines(draft.reach.rules, places.machines, undefined, places.workspaceRefs),
    [draft.reach.rules, places.machines, places.workspaceRefs]);
  const held = state.busy || state.receipt !== null;
  return <>
    <SkillInstructionsSection testID="skill.draft.instructions" skillId="new" skillMd={state.text} readOnly={held ? {} : false} draft={editorDraft}
      onSave={neverSaves} onDirtyChange={noDirty} readTheirs={noTheirs} adoptTheirs={noAdopt} />
    <WhereItsOnControl testID="skill.draft.where" kind="skill" presentation="section" rules={draft.reach.rules}
      {...(held ? { readOnlyReason: state.busy ? t('capabilities.skillDetail.draft.adding') : t('capabilities.add.added') } : {})}
      status="ready" projection={projection} places={{ agentIds: places.agentIds, machines: places.placeMachines, projects: places.projects }}
      agentTakes={places.agentTakes} onChange={draft.reach.onChange} />
  </>;
}

const styles = StyleSheet.create((theme) => ({
  note: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
}));
