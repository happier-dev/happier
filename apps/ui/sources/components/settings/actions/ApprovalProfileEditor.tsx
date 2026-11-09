import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type {
  ApprovalProfileModeV1,
  ApprovalProfileV1,
} from '@happier-dev/protocol/actions';

import {
  RoundButton,
  RoundButtonSizeScope,
} from '@/components/ui/buttons/RoundButton';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { ListPresentationProvider } from '@/components/ui/lists/listPresentation';
import { SegmentedChoiceItem } from '@/components/ui/lists/SegmentedChoiceItem';
import { FloatingOverlay } from '@/components/ui/overlays/FloatingOverlay';
import { Text } from '@/components/ui/text/Text';
import {
  TRIGGER_POPOVER_WIDTH,
  TriggerAnchoredPopoverShell,
} from '@/components/workflows/triggers/TriggerPopover';
import { t } from '@/text';

import {
  approvalProfileFromDraft,
  draftFromApprovalProfile,
  type ApprovalProfileDraft,
} from './approvalProfileDraft';

const MODES: readonly ApprovalProfileModeV1[] = ['require', 'ask', 'allow'];
const MODE_KEY = {
  require: 'modeRequire',
  ask: 'modeAsk',
  allow: 'modeAllow',
} as const;

/**
 * A custom approval profile: its name, the default, and the routine/risky overlays. Saving writes the
 * whole profile through the profile Action; per-Action overrides it does not show are kept.
 */
export function ApprovalProfileEditor(
  props: Readonly<{
    anchorRef: React.RefObject<View | null>;
    profile: ApprovalProfileV1 | null;
    onSave: (profile: ApprovalProfileV1) => Promise<boolean>;
    onDelete?: () => void;
    onRequestClose: () => void;
  }>,
) {
  const testID = 'settings-actions:approval-profile-editor';
  const [draft, setDraft] = React.useState<ApprovalProfileDraft>(() =>
    draftFromApprovalProfile(props.profile),
  );
  const [pending, setPending] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const profile = approvalProfileFromDraft(draft);
  const change = (patch: Partial<ApprovalProfileDraft>) => {
    setFailed(false);
    setDraft((current) => ({ ...current, ...patch }));
  };
  const options = MODES.map((mode) => ({
    id: mode,
    label: t(`workflows.triggers.guided.profile.${MODE_KEY[mode]}`),
  }));
  const save = async () => {
    if (!profile) return;
    setPending(true);
    const ok = await props.onSave(profile);
    setPending(false);
    if (ok) props.onRequestClose();
    else setFailed(true);
  };
  const title = t(
    props.profile
      ? 'workflows.triggers.guided.profile.editTitle'
      : 'workflows.triggers.guided.profile.newTitle',
  );
  return (
    <TriggerAnchoredPopoverShell
      open
      phonePresentation="sheet"
      accessibilityLabel={title}
      anchorRef={props.anchorRef}
      maxWidthCap={TRIGGER_POPOVER_WIDTH}
      maxHeightCap={640}
      autoFocusOnOpen
      onRequestClose={props.onRequestClose}
    >
      {({ maxHeight, placement, presentation }) => (
        <FloatingOverlay
          maxHeight={maxHeight}
          scrollEnabled
          surfaceChrome="theme"
          arrow={placement ? { placement } : false}
          footer={
            <RoundButtonSizeScope size="small" presentation="uniform">
              <View style={styles.foot}>
                {props.onDelete ? (
                  <RoundButton
                    size="small"
                    display="secondary"
                    testID={`${testID}-delete`}
                    title={t('common.delete')}
                    onPress={props.onDelete}
                  />
                ) : null}
                <View style={styles.footEnd}>
                  <RoundButton
                    size="small"
                    display="inverted"
                    testID={`${testID}-cancel`}
                    title={t('common.cancel')}
                    onPress={props.onRequestClose}
                  />
                  <RoundButton
                    size="small"
                    testID={`${testID}-save`}
                    title={t('common.save')}
                    disabled={!profile}
                    loading={pending}
                    onPress={() => void save()}
                  />
                </View>
              </View>
            </RoundButtonSizeScope>
          }
        >
          <ListPresentationProvider value="page">
            <View testID={testID} style={styles.surface}>
              <ItemGroup
                surface="none"
                // A phone sheet already carries the title in its header.
                {...(presentation === 'sheet' ? {} : { title })}
                description={t(
                  'workflows.triggers.guided.profile.modesDescription',
                )}
              >
                <Item
                  title={t('workflows.triggers.guided.profile.nameLabel')}
                  showChevron={false}
                  accessoryLayout="stacked"
                  rightElement={
                    <FieldTextInput
                      testID={`${testID}-name`}
                      value={draft.name}
                      placeholder={t(
                        'workflows.triggers.guided.profile.namePlaceholder',
                      )}
                      accessibilityLabel={t(
                        'workflows.triggers.guided.profile.nameLabel',
                      )}
                      onChangeText={(name) => change({ name })}
                    />
                  }
                />
                <SegmentedChoiceItem<ApprovalProfileModeV1>
                  accessoryLayout="stacked"
                  labelSize="field"
                  testIDPrefix={`${testID}-default`}
                  title={t('workflows.triggers.guided.profile.defaultLabel')}
                  value={draft.defaultMode}
                  options={options}
                  // Moving the default carries overlays that matched it, so only real exceptions stay.
                  onChange={(defaultMode) =>
                    change({
                      defaultMode,
                      safe:
                        draft.safe === draft.defaultMode
                          ? defaultMode
                          : draft.safe,
                      danger:
                        draft.danger === draft.defaultMode
                          ? defaultMode
                          : draft.danger,
                    })
                  }
                />
                <SegmentedChoiceItem<ApprovalProfileModeV1>
                  accessoryLayout="stacked"
                  labelSize="field"
                  testIDPrefix={`${testID}-safe`}
                  title={t('workflows.triggers.guided.profile.safeLabel')}
                  value={draft.safe}
                  options={options}
                  valueSource={
                    draft.safe === draft.defaultMode ? 'inherited' : 'set'
                  }
                  onChange={(safe) => change({ safe })}
                />
                <SegmentedChoiceItem<ApprovalProfileModeV1>
                  accessoryLayout="stacked"
                  labelSize="field"
                  testIDPrefix={`${testID}-danger`}
                  title={t('workflows.triggers.guided.profile.dangerLabel')}
                  value={draft.danger}
                  options={options}
                  valueSource={
                    draft.danger === draft.defaultMode ? 'inherited' : 'set'
                  }
                  onChange={(danger) => change({ danger })}
                />
              </ItemGroup>
              {failed ? (
                <Text
                  testID={`${testID}-failure`}
                  accessibilityLiveRegion="polite"
                  style={styles.failure}
                >
                  {t('workflows.triggers.guided.profile.saveFailed')}
                </Text>
              ) : null}
            </View>
          </ListPresentationProvider>
        </FloatingOverlay>
      )}
    </TriggerAnchoredPopoverShell>
  );
}

const styles = StyleSheet.create((theme) => ({
  surface: { width: TRIGGER_POPOVER_WIDTH, maxWidth: '100%' },
  foot: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.space.s8,
    paddingHorizontal: theme.space.s16,
    paddingTop: theme.space.s12,
    paddingBottom: theme.space.s16,
  },
  footEnd: { marginLeft: 'auto', flexDirection: 'row', gap: theme.space.s8 },
  failure: {
    color: theme.colors.state.danger.foreground,
    paddingHorizontal: theme.space.s16,
    paddingBottom: theme.space.s8,
  },
}));
