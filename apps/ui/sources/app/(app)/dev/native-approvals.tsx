import * as React from 'react';
import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';

import {
  NativeApprovalSpecimen,
  type NativeApprovalSpecimenState,
} from '@/components/dev/approvals/NativeApprovalSpecimen';

const STATES: readonly NativeApprovalSpecimenState[] = [
  'two',
  'four',
  'six',
  'long',
  'shared',
  'child',
  'answered',
];

/** Dev-only: offered native approval choices in the lab's scenes (lab mb B), credential-free for visual QA. */
export default function NativeApprovalsDevScreen() {
  const params = useLocalSearchParams<{ state?: string }>();
  const state =
    STATES.find((candidate) => candidate === params.state) ?? 'four';
  return (
    <View style={styles.container} testID="dev-native-approvals-screen">
      <View style={styles.column}>
        <NativeApprovalSpecimen state={state} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    justifyContent: 'flex-end',
    alignItems: 'center',
    padding: theme.space.s16,
    backgroundColor: theme.colors.background.canvas,
  },
  column: {
    width: '100%',
    maxWidth: 944,
  },
}));
