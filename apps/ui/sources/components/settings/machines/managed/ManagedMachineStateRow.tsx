import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { happierPageTextMetrics } from '@happier-dev/plugin-ui/presentation';

import { useRouter } from '@/components/appShell/workspace/destinationRoute';
import { SETTINGS_ROUTES } from '@/components/settings/catalog/routes';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ActivitySpinner } from '@/components/ui/feedback/ActivitySpinner';
import { AttentionBanner } from '@/components/ui/lists/AttentionBanner';
import { Item } from '@/components/ui/lists/Item';
import { Text } from '@/components/ui/text/Text';
import { Typography } from '@/constants/Typography';

import {
  describeManagedLifecycleState,
  managedLifecycleActionLabel,
  type ManagedLifecycleAction,
  type ManagedLifecycleState,
} from './managedLifecyclePresentation';

export type ManagedLifecycleHandlers = Partial<
  Record<ManagedLifecycleAction, () => void>
>;

/**
 * A created machine in a state that needs words (lab `m-life`). A state that blocks use or leaves
 * billing uncertain is the page's banner, titled with the state and carrying its next step; every
 * other state is a fact on the resource's own row: its mark and name, then the cause — the only
 * tinted words — and the plain next step. An action renders only when its owner supplied it, so
 * nothing offers a button that cannot work. The first action is the bordered one; the rest stay quiet.
 */
export const ManagedMachineStateRow = React.memo(
  function ManagedMachineStateRow(
    props: Readonly<{
      name: string;
      mark: React.ReactNode;
      state: ManagedLifecycleState;
      /** The provider's name, for "Open Hetzner". */
      provider?: string;
      handlers: ManagedLifecycleHandlers;
      /** A resource that ended reads dimmed: it is history, not something to act on. */
      ended?: boolean;
      testID: string;
    }>,
  ) {
    const { theme } = useUnistyles();
    const presentation = describeManagedLifecycleState(props.state);
    const actions = presentation.actions.filter(
      (action) => props.handlers[action] !== undefined,
    );
    if (presentation.banner) {
      const [first, ...rest] = actions.map((action) => ({
        label: managedLifecycleActionLabel(action, props.provider),
        onPress: props.handlers[action]!,
        testID: `${props.testID}:${action}`,
      }));
      return (
        <AttentionBanner
          testID={props.testID}
          tone={
            presentation.tone === 'danger'
              ? 'danger'
              : presentation.tone === 'warning'
                ? 'warning'
                : 'neutral'
          }
          title={presentation.banner.title}
          description={presentation.detail}
          // The bordered next step leads; a way out of the app (Open Hetzner) stays quiet beside it.
          action={first ?? null}
          secondaryAction={rest[0] ?? null}
          moreActions={rest.slice(1)}
        />
      );
    }
    const tint =
      presentation.tone === 'warning'
        ? theme.colors.state.warning.foreground
        : presentation.tone === 'danger'
          ? theme.colors.state.danger.foreground
          : null;
    return (
      <Item
        testID={props.testID}
        title={props.name}
        subtitle={
          tint && presentation.cause ? (
            <Text style={styles.line}>
              <Text style={{ color: tint }}>{presentation.cause}</Text>
              {presentation.detail ? ` ${presentation.detail}` : null}
            </Text>
          ) : (
            presentation.line
          )
        }
        subtitleLines={0}
        subtitleLeading={
          presentation.tone === 'pending' ? (
            <ActivitySpinner
              size="small"
              accessibilityElementsHidden
              importantForAccessibility="no"
            />
          ) : undefined
        }
        icon={props.mark}
        disabled={props.ended}
        mode="info"
        showChevron={false}
        rightElement={
          actions.length > 0 ? (
            <View style={styles.actions}>
              {actions.map((action, index) => (
                <RoundButton
                  key={action}
                  testID={`${props.testID}:${action}`}
                  size="small"
                  display={
                    index === 0 && !props.ended ? 'secondary' : 'inverted'
                  }
                  title={managedLifecycleActionLabel(action, props.provider)}
                  onPress={props.handlers[action]!}
                />
              ))}
            </View>
          ) : undefined
        }
      />
    );
  },
);

/**
 * "Creating machines is off" wherever a creation path is opened (lab `m-life` 9): a neutral banner
 * whose Change opens the Account default that turned it off. Machines already created keep their
 * rows and cleanup; this notice never hides them.
 */
export const ManagedCreationDisabledBanner = React.memo(
  function ManagedCreationDisabledBanner(props: Readonly<{ testID: string }>) {
    const router = useRouter();
    const handlers = React.useMemo<ManagedLifecycleHandlers>(
      () => ({
        change: () => router.push(SETTINGS_ROUTES.machineDefaults as never),
      }),
      [router],
    );
    return (
      <ManagedMachineStateRow
        testID={props.testID}
        name=""
        mark={null}
        state={CREATION_DISABLED}
        handlers={handlers}
      />
    );
  },
);

const CREATION_DISABLED: ManagedLifecycleState = { kind: 'creationDisabled' };

const styles = StyleSheet.create((theme) => ({
  actions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  // The row description's own step: the same metrics a banner's description uses.
  line: {
    ...Typography.default('regular'),
    ...happierPageTextMetrics('rowDescription'),
    color: theme.colors.text.secondary,
  },
}));
