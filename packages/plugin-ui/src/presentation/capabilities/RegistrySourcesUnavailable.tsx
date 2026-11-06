import * as React from 'react';
import { View } from 'react-native';
import { useHappierUiTheme } from '../../environment/context.js';
import { HAPPIER_STATE_LINE_METRICS } from '../state/InfoState.js';
import type { HappierSurfaceStateAction } from '../state/SurfaceState.js';

export type RegistrySourceFailure = Readonly<{
  key: string;
  message: string;
  /** The same words apart, for a page whose one failure is its state: the catalog as the title, its reason beneath. */
  source?: string;
  reason?: string;
  /** Technical facts for support, shown only when asked for. */
  details?: readonly string[];
  onRetry: () => void | Promise<void>;
}>;

export type RegistrySourcesUnavailableProps = Readonly<{
  failures: readonly RegistrySourceFailure[];
  testID: string;
  size?: 'line' | 'page';
}>;
export type RegistrySourcesUnavailableLabels = Readonly<{
  sourcesUnreachable: (count: number) => string;
  retry: string;
  showDetails: string;
  hideDetails: string;
}>;
export type RegistrySourcesUnavailableStateProps = Readonly<{
  testID: string;
  kind: 'unavailable';
  size: 'line' | 'page';
  title: string;
  reason?: string;
  action: HappierSurfaceStateAction;
  secondaryAction?: HappierSurfaceStateAction;
}>;
export type RegistrySourcesUnavailableHost = Readonly<{
  State: React.ComponentType<RegistrySourcesUnavailableStateProps>;
  DetailText: React.ComponentType<Readonly<{ children: React.ReactNode }>>;
  retry: (onRetry: RegistrySourceFailure['onRetry']) => void;
}>;

/** One quiet outage composition, with disclosure and one invocation per distinct read. */
export function HappierRegistrySourcesUnavailable(props: RegistrySourcesUnavailableProps & Readonly<{
  labels: RegistrySourcesUnavailableLabels;
  host: RegistrySourcesUnavailableHost;
}>): React.ReactNode {
  const theme = useHappierUiTheme();
  const [open, setOpen] = React.useState(false);
  const { failures } = props;
  if (failures.length === 0) return null;
  const retry = () => {
    for (const onRetry of new Set(failures.map((failure) => failure.onRetry))) {
      props.host.retry(onRetry);
    }
  };
  const single = failures.length === 1 ? failures[0]! : null;
  const pageState = props.size === 'page' && single?.source && single.reason ? single : null;
  const details = failures.flatMap((failure) => failure.details ?? []);
  const revealable = !single || details.length > 0;
  return (
    <View>
      <props.host.State
        testID={props.testID}
        kind="unavailable"
        size={props.size ?? 'line'}
        title={
          pageState?.source ?? (single
            ? single.message
            : props.labels.sourcesUnreachable(failures.length))
        }
        {...(pageState?.reason ? { reason: pageState.reason } : {})}
        action={{
          label: props.labels.retry,
          onPress: retry,
          testID: `${props.testID}.retry`,
        }}
        {...(!revealable
          ? {}
          : {
              secondaryAction: {
                label: open
                  ? props.labels.hideDetails
                  : props.labels.showDetails,
                onPress: () => setOpen((value) => !value),
                testID: `${props.testID}.details`,
              },
            })}
      />
      {revealable && open ? (
        <View style={{ gap: theme.spacing.xsmall, paddingLeft: HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx + HAPPIER_STATE_LINE_METRICS.glyphPx + HAPPIER_STATE_LINE_METRICS.gapPx, paddingRight: HAPPIER_STATE_LINE_METRICS.paddingHorizontalPx, paddingBottom: theme.spacing.small }} testID={`${props.testID}.sources`}>
          {(single ? [] : failures.map((failure) => failure.message)).concat(details).map((line, index) => (
            <props.host.DetailText key={index} >
              {line}
            </props.host.DetailText>
          ))}
        </View>
      ) : null}
    </View>
  );
}
