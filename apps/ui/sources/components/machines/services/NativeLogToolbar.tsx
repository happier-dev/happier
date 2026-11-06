import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';

import { IconButton } from '@/components/ui/buttons/IconButton';
import { ToolbarButton } from '@/components/ui/buttons/ToolbarButton';
import { FindBar } from '@/components/ui/find/FindBar';
import { Icon } from '@/components/ui/icons/Icon';
import { t } from '@/text';

import type { useNativeLogViewer } from './useMachineServiceLogViewer';

type NativeLogViewer = ReturnType<typeof useNativeLogViewer>['viewer'];
type ToolbarPart = 'find' | 'findbar' | 'follow' | 'copy' | 'save';

/**
 * The one toolbar over a native log (a Machine service's log, a deploy step's log): Find, which opens in its own
 * place, an optional filter, then Follow, Copy and Save. Each log owns its reads; this draws only the controls.
 */
export function NativeLogToolbar(
  props: Readonly<{
    viewer: NativeLogViewer | null;
    /** Whether Find is open here: the log decides (a hidden log keeps it closed). */
    findOpen: boolean;
    /** Each control's test id. */
    partTestID: (part: ToolbarPart) => string;
    testID?: string;
    /** Notes whether the Find field has focus, so the log's shortcuts stand aside while typing. */
    inputFocused: React.MutableRefObject<boolean>;
    /** A filter beside Find (all steps / failed only); hidden while Find is open. */
    filter?: React.ReactNode;
    /** Absent where the log cannot follow new lines. */
    follow?: Readonly<{ on: boolean; toggle: () => void }> | null;
    onCopy: () => void;
    copyDisabled?: boolean;
    onSave: () => void;
    saveDisabled?: boolean;
  }>,
) {
  const { theme } = useUnistyles();
  const { viewer, partTestID } = props;
  const { findOpen } = props;
  const findStatus = viewer?.findSnapshot.status;
  const findLabel =
    viewer?.findSnapshot.query && findStatus?.kind === 'results'
      ? `${viewer.findSnapshot.query} · ${findStatus.total}`
      : t('machineServices.logs.findInLog');
  return (
    <View style={styles.toolbar} testID={props.testID}>
      {findOpen && viewer ? (
        <View style={styles.find}>
          <FindBar
            query={viewer.find.query}
            options={viewer.find.options}
            status={viewer.find.status}
            capabilities={viewer.find.capabilities}
            surfaceLabel={t('machineServices.logs.findInLog')}
            presentation="inline"
            autoFocus
            onInputFocus={() => {
              props.inputFocused.current = true;
            }}
            onInputBlur={() => {
              props.inputFocused.current = false;
            }}
            onQueryChange={viewer.find.setQuery}
            onOptionsChange={viewer.find.setOptions}
            onStep={viewer.find.step}
            onStop={viewer.find.stop}
            onClose={viewer.find.close}
            testID={partTestID('findbar')}
          />
        </View>
      ) : (
        <ToolbarButton
          testID={partTestID('find')}
          label={findLabel}
          icon={
            <Icon
              name="magnifying-glass"
              size={14}
              color={theme.colors.text.secondary}
            />
          }
          disabled={!viewer?.available}
          onPress={() => viewer?.find.open()}
        />
      )}
      {findOpen ? null : props.filter}
      {findOpen ? null : <View style={styles.spacer} />}
      {props.follow ? (
        <ToolbarButton
          testID={partTestID('follow')}
          label={
            props.follow.on
              ? t('machineServices.logs.following')
              : t('machineServices.logs.follow')
          }
          accessibilityLabel={
            props.follow.on
              ? t('machineServices.logs.stopFollowing')
              : t('machineServices.logs.follow')
          }
          active={props.follow.on}
          onPress={props.follow.toggle}
        />
      ) : null}
      <IconButton
        testID={partTestID('copy')}
        variant="plain"
        size={30}
        iconSize={16}
        iconName="copy"
        accessibilityLabel={t('machineServices.logs.copyLog')}
        disabled={props.copyDisabled}
        onPress={props.onCopy}
      />
      <IconButton
        testID={partTestID('save')}
        variant="plain"
        size={30}
        iconSize={16}
        iconName="download"
        accessibilityLabel={t('machineServices.logs.saveLog')}
        disabled={props.saveDisabled}
        onPress={props.onSave}
      />
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toolbar: { flexDirection: 'row', alignItems: 'center', gap: theme.space.s8 },
  spacer: { flex: 1 },
  // The open field takes the toolbar's free span; the shared bar measures that span, sits at its end beside
  // Follow, and draws its compact capsule on a phone instead of clipping.
  find: { flexGrow: 1, flexBasis: 0, minWidth: 0 },
}));
