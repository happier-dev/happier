import * as React from 'react';
import { Platform, Pressable, ScrollView, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { darkTheme, lightTheme } from '@/theme';
import { Typography } from '@/constants/Typography';

type AppCrashRecoveryBoundaryProps = Readonly<{
  children: React.ReactNode;
  onRestart: () => void;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}>;

type AppCrashRecoveryBoundaryState = {
  error: Error | null;
  copied: boolean;
};

export type AppBlockingScreenAction = Readonly<{
  testID: string;
  label: string;
  onPress: () => void;
  variant: 'primary' | 'secondary';
}>;

function resolveFallbackTheme() {
  try {
    const Appearance = (require('react-native') as any).Appearance;
    const scheme: unknown = Appearance?.getColorScheme?.();
    return scheme === 'dark' ? darkTheme : lightTheme;
  } catch {
    return lightTheme;
  }
}

function formatErrorDetails(error: Error): string {
  const message = typeof error.message === 'string' ? error.message : String(error);
  const stack = typeof error.stack === 'string' ? error.stack : '';
  return stack ? `${message}\n\n${stack}` : message;
}

export function AppBlockingScreen(props: Readonly<{
  testID?: string;
  header?: React.ReactNode;
  title: string;
  subtitle: string;
  detailsTitle: string;
  details: string;
  actions: ReadonlyArray<AppBlockingScreenAction>;
}>): React.ReactElement {
  const theme = resolveFallbackTheme();

  const primary = props.actions.filter((a) => a.variant === 'primary');
  const secondary = props.actions.filter((a) => a.variant === 'secondary');
  const ordered = [...primary, ...secondary];

  return (
    <View testID={props.testID} style={[styles.container, { backgroundColor: theme.colors.surface }]}>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        {props.header ? (
          <View style={styles.blockingHeader}>
            {props.header}
          </View>
        ) : null}
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <View style={[styles.dot, { backgroundColor: theme.colors.warningCritical }]} />
            <View style={styles.titleColumn}>
              <View>
                <TextBlock
                  text={props.title}
                  style={[styles.title, { color: theme.colors.text }]}
                />
                <TextBlock
                  text={props.subtitle}
                  style={[styles.subtitle, { color: theme.colors.textSecondary }]}
                />
              </View>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: theme.colors.surfaceHigh, borderColor: theme.colors.divider }]}>
          <TextBlock
            text={props.detailsTitle}
            style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}
          />
          <TextBlock
            text={props.details}
            style={[styles.details, { color: theme.colors.text }]}
            selectable
          />
        </View>

        <View style={styles.actions}>
          {ordered.map((action) => {
            if (action.variant === 'primary') {
              return (
                <Pressable
                  key={action.testID}
                  testID={action.testID}
                  accessibilityRole="button"
                  onPress={action.onPress}
                  style={({ pressed }) => [
                    styles.primaryButton,
                    {
                      backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.accent.blue,
                      borderColor: theme.colors.divider,
                    },
                  ]}
                >
                  <TextBlock
                    text={action.label}
                    style={[styles.primaryButtonText, { color: theme.colors.overlay.text }]}
                  />
                </Pressable>
              );
            }

            return (
              <Pressable
                key={action.testID}
                testID={action.testID}
                accessibilityRole="button"
                onPress={action.onPress}
                style={({ pressed }) => [
                  styles.secondaryButton,
                  {
                    backgroundColor: pressed ? theme.colors.surfacePressed : theme.colors.surfaceHighest,
                    borderColor: theme.colors.divider,
                  },
                ]}
              >
                <TextBlock
                  text={action.label}
                  style={[styles.secondaryButtonText, { color: theme.colors.text }]}
                />
              </Pressable>
            );
          })}
        </View>
      </ScrollView>
    </View>
  );
}

export class AppCrashRecoveryBoundary extends React.PureComponent<
  AppCrashRecoveryBoundaryProps,
  AppCrashRecoveryBoundaryState
> {
  state: AppCrashRecoveryBoundaryState = { error: null, copied: false };

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ error, copied: false });
    try {
      this.props.onError?.(error, info);
    } catch {
      // ignore
    }
  }

  private readonly onCopyDetails = () => {
    const error = this.state.error;
    if (!error) return;
    const details = formatErrorDetails(error);
    void Clipboard.setStringAsync(details)
      .then(() => {
        this.setState({ copied: true });
      })
      .catch(() => {});
  };

  override render(): React.ReactNode {
    const error = this.state.error;

    if (!error) {
      return this.props.children;
    }

    const primaryAction: AppBlockingScreenAction = {
      testID: 'app-crash-restart',
      label: t('appCrash.restart'),
      onPress: this.props.onRestart,
      variant: 'primary',
    };
    const secondaryAction: AppBlockingScreenAction = {
      testID: 'app-crash-copy-details',
      label: this.state.copied ? t('common.copied') : t('appCrash.copyDetails'),
      onPress: this.onCopyDetails,
      variant: 'secondary',
    };

    return (
      <AppBlockingScreen
        title={t('appCrash.title')}
        subtitle={t('appCrash.subtitle')}
        detailsTitle={t('appCrash.detailsTitle')}
        details={formatErrorDetails(error)}
        actions={[primaryAction, secondaryAction]}
      />
    );
  }
}

function TextBlock(props: { text: string; style: any; selectable?: boolean }) {
  // Avoid pulling in app-specific Text components/hooks in the crash fallback path.
  const { text, style, selectable } = props;
  const Text = require('react-native').Text as typeof import('react-native').Text;
  return (
    <Text selectable={selectable} style={style}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  content: {
    paddingHorizontal: 16,
    paddingTop: Platform.OS === 'web' ? 24 : 40,
    paddingBottom: 40,
    gap: 16,
  },
  blockingHeader: {
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  header: {
    gap: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    marginTop: 6,
  },
  titleColumn: {
    flex: 1,
  },
  title: {
    ...Typography.default('semiBold'),
    fontSize: 18,
    lineHeight: 24,
  },
  subtitle: {
    ...Typography.default(),
    fontSize: 14,
    lineHeight: 20,
    marginTop: 6,
  },
  card: {
    borderWidth: 1,
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    gap: 10,
  },
  sectionTitle: {
    ...Typography.default('semiBold'),
    fontSize: 12,
    letterSpacing: 0.4,
  },
  details: {
    ...Typography.mono(),
    fontSize: 12,
    lineHeight: 18,
  },
  actions: {
    gap: 10,
  },
  primaryButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primaryButtonText: {
    ...Typography.default('semiBold'),
    fontSize: 14,
  },
  secondaryButton: {
    borderWidth: 1,
    borderRadius: 12,
    paddingVertical: 12,
    alignItems: 'center',
    justifyContent: 'center',
  },
  secondaryButtonText: {
    ...Typography.default('semiBold'),
    fontSize: 14,
  },
});
