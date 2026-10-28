import * as React from 'react';
import { Appearance, Image, Platform, Pressable, ScrollView, View, type StyleProp, type TextStyle } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { StyleSheet } from 'react-native-unistyles';

import { t } from '@/text';
import { darkTheme, lightTheme } from '@/theme';
import { loadThemeRuntimeLocalState } from '@/sync/domains/state/persistence';
import {
  resolveThemeRuntimeThemes,
  resolveThemeRuntimeVisualTheme,
} from '@/theme/profiles/themeProfileRuntime';
import { Typography } from '@/constants/Typography';
import { getBugReportUserActionTrail } from '@/utils/system/bugReportActionTrail';
import { getBugReportLogText } from '@/utils/system/bugReportLogBuffer';
import { persistPreRestartBugReportSnapshot } from '@/utils/system/preRestartBugReportSnapshot';
import { persistRestartBugReportIntent } from '@/utils/system/restartBugReportIntent';
import { requireReactNativeScreens } from '@/utils/web/reactNativeScreensCjs';

type AppCrashRecoveryBoundaryProps = Readonly<{
  children: React.ReactNode;
  onRestart: () => void;
  onError?: (error: Error, info: React.ErrorInfo) => void;
}>;

type AppCrashRecoveryBoundaryState = {
  error: Error | null;
  copied: boolean;
  componentStack: string;
  capturedAtMs: number;
  saveFailed: boolean;
};

export type AppBlockingScreenAction = Readonly<{
  testID: string;
  label: string;
  onPress: () => void;
  variant: 'primary' | 'secondary';
}>;

function readSystemThemeForCrashRecovery(): 'light' | 'dark' | null {
  try {
    return Appearance.getColorScheme() === 'dark' ? 'dark' : 'light';
  } catch {
    return null;
  }
}

export function resolveCrashRecoveryFallbackTheme() {
  try {
    const { themePreference, themeProfiles } = loadThemeRuntimeLocalState();
    const themes = resolveThemeRuntimeThemes(themeProfiles);
    const visualTheme = resolveThemeRuntimeVisualTheme(themePreference, readSystemThemeForCrashRecovery());
    return themes[visualTheme];
  } catch {
    const visualTheme = resolveThemeRuntimeVisualTheme('adaptive', readSystemThemeForCrashRecovery());
    return visualTheme === 'dark' ? darkTheme : lightTheme;
  }
}

function formatErrorDetails(error: Error, componentStack: string): string {
  const message = typeof error.message === 'string' ? error.message : String(error);
  const stack = typeof error.stack === 'string' ? error.stack : '';
  const details = stack ? `${message}\n\n${stack}` : message;
  return componentStack ? `${details}\n\n${componentStack}` : details;
}

function readOriginForDiagnostics(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return String(window.location?.href ?? '').trim() || null;
  } catch {
    return null;
  }
}

function readIsSecureContextForDiagnostics(): boolean | null {
  if (typeof window === 'undefined') return null;
  try {
    return typeof window.isSecureContext === 'boolean' ? window.isSecureContext : null;
  } catch {
    return null;
  }
}

function NativeCrashRecoveryOverlay(props: Readonly<{ children: React.ReactNode }>): React.ReactElement {
  if (Platform.OS === 'ios') {
    try {
      const FullWindowOverlay = requireReactNativeScreens()?.FullWindowOverlay as
        | React.ComponentType<{ children?: React.ReactNode }>
        | undefined;
      if (FullWindowOverlay) {
        return <FullWindowOverlay>{props.children}</FullWindowOverlay>;
      }
    } catch {
      // Fall through to a root overlay if react-native-screens is unavailable in this runtime.
    }
  }

  return (
    <View
      testID="app-crash-recovery-native-overlay-fallback"
      style={styles.nativeOverlayFallback}
      pointerEvents="auto"
    >
      {props.children}
    </View>
  );
}

export function AppBlockingScreen(props: Readonly<{
  testID?: string;
  title: string;
  subtitle: string;
  detailsTitle: string;
  details: string;
  actions: ReadonlyArray<AppBlockingScreenAction>;
  notice?: string;
}>): React.ReactElement {
  const theme = resolveCrashRecoveryFallbackTheme();

  const primary = props.actions.filter((a) => a.variant === 'primary');
  const secondary = props.actions.filter((a) => a.variant === 'secondary');
  const ordered = [...primary, ...secondary];

  return (
    <View testID={props.testID} style={[styles.container, { backgroundColor: theme.colors.surface.base }]}>
      <ScrollView
        style={styles.scrollView}
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.blockingHeader}>
          <Image
            testID="app-blocking-logo"
            source={theme.dark ? require('@/assets/images/logotype-light.png') : require('@/assets/images/logotype-dark.png')}
            resizeMode="contain"
            style={styles.logo}
          />
        </View>
        <View style={styles.header}>
          <View style={styles.titleRow}>
            <View style={[styles.dot, { backgroundColor: theme.colors.state.danger.foreground }]} />
            <View style={styles.titleColumn}>
              <View>
                <TextBlock
                  text={props.title}
                  style={[styles.title, { color: theme.colors.text.primary }]}
                />
                <TextBlock
                  text={props.subtitle}
                  style={[styles.subtitle, { color: theme.colors.text.secondary }]}
                />
              </View>
            </View>
          </View>
        </View>

        <View style={[styles.card, { backgroundColor: theme.colors.surface.inset, borderColor: theme.colors.border.default }]}>
          <TextBlock
            text={props.detailsTitle}
            style={[styles.sectionTitle, { color: theme.colors.text.secondary }]}
          />
          <TextBlock
            text={props.details}
            style={[styles.details, { color: theme.colors.text.primary }]}
            selectable
          />
        </View>

        {props.notice && (
          <View testID="app-crash-report-save-failed" accessibilityRole="alert">
            <TextBlock text={props.notice} style={[styles.subtitle, { color: theme.colors.text.primary }]} />
          </View>
        )}
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
                      backgroundColor: pressed ? theme.colors.surface.pressed : theme.colors.accent.blue,
                      borderColor: theme.colors.border.default,
                    },
                  ]}
                >
                  <TextBlock
                    text={action.label}
                    style={[styles.primaryButtonText, { color: theme.colors.overlay.foreground }]}
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
                    backgroundColor: pressed ? theme.colors.surface.pressed : theme.colors.surface.elevated,
                    borderColor: theme.colors.border.default,
                  },
                ]}
              >
                <TextBlock
                  text={action.label}
                  style={[styles.secondaryButtonText, { color: theme.colors.text.primary }]}
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
  state: AppCrashRecoveryBoundaryState = { error: null, copied: false, componentStack: '', capturedAtMs: 0, saveFailed: false };

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.setState({ error, copied: false, componentStack: info.componentStack ?? '', capturedAtMs: Date.now(), saveFailed: false });
    try {
      this.props.onError?.(error, info);
    } catch {
      // ignore
    }
  }

  private readonly onCopyDetails = () => {
    const error = this.state.error;
    if (!error) return;
    const details = formatErrorDetails(error, this.state.componentStack);
    void Clipboard.setStringAsync(details)
      .then(() => {
        this.setState({ copied: true });
      })
      .catch(() => {});
  };

  private readonly onRestart = () => this.persistAndRestart(false);
  private readonly onReportBug = () => this.persistAndRestart(true);

  private readonly persistAndRestart = (openReport: boolean) => {
    const error = this.state.error;
    if (!error) return;

    const createdAtMs = this.state.capturedAtMs;
    const origin = readOriginForDiagnostics();
    const isSecureContext = readIsSecureContextForDiagnostics();
    const errorDetails = formatErrorDetails(error, this.state.componentStack);

    void (async () => {
      try {
        await persistPreRestartBugReportSnapshot({
          v: 1,
          createdAtMs,
          reason: 'crash',
          platform: Platform.OS,
          origin,
          isSecureContext,
          errorDetails,
          appLogs: getBugReportLogText(),
          userActions: getBugReportUserActionTrail(),
        });

        if (openReport) {
          await persistRestartBugReportIntent({ v: 1, createdAtMs: Date.now(), reason: 'crash' });
        }
        this.props.onRestart();
      } catch {
        // Keep the only copy visible and copyable when capture or routing could not be saved.
        this.setState({ saveFailed: true });
      }
    })();
  };

  override render(): React.ReactNode {
    const error = this.state.error;

    if (!error) {
      return this.props.children;
    }

    const primaryAction: AppBlockingScreenAction = {
      testID: 'app-crash-restart',
      label: this.state.saveFailed ? t('appCrash.restartWithoutReport') : t('appCrash.restart'),
      onPress: this.state.saveFailed ? this.props.onRestart : this.onRestart,
      variant: 'primary',
    };
    const secondaryAction: AppBlockingScreenAction = {
      testID: 'app-crash-copy-details',
      label: this.state.copied ? t('common.copied') : t('appCrash.copyDetails'),
      onPress: this.onCopyDetails,
      variant: 'secondary',
    };

    const reportBugAction: AppBlockingScreenAction = {
      testID: 'app-crash-report-bug',
      label: t('appCrash.restartAndReportIssue'),
      onPress: this.onReportBug,
      variant: 'secondary',
    };

    const fallback = (
      <AppBlockingScreen
        title={t('appCrash.title')}
        subtitle={t('appCrash.subtitle')}
        detailsTitle={t('appCrash.detailsTitle')}
        details={formatErrorDetails(error, this.state.componentStack)}
        notice={this.state.saveFailed ? t('appCrash.reportSaveFailed') : undefined}
        actions={[primaryAction, reportBugAction, secondaryAction]}
      />
    );

    if (Platform.OS === 'web') {
      return fallback;
    }

    // On native, a crash can leave a natively-presented screen container (react-native-screens
    // stack/modal) frozen on top of the root view. Rendering the fallback inline then paints
    // BENEATH that dead frame: the recovery UI mounts (it is present in the accessibility tree)
    // but the user keeps seeing the old frozen screen with dead touches (issue-2, 2026-06-12).
    // On iOS, the react-native-screens full-window overlay presents it above stuck native view
    // controllers without adding another RN ModalHostView tree. Other native platforms use the
    // root overlay fallback because FullWindowOverlay is iOS-only.
    return (
      <NativeCrashRecoveryOverlay>
        {fallback}
      </NativeCrashRecoveryOverlay>
    );
  }
}

function TextBlock(props: { text: string; style: StyleProp<TextStyle>; selectable?: boolean }) {
  // Avoid pulling in app-specific Text components/hooks in the crash fallback path.
  const { text, style, selectable } = props;
  const Text = require('react-native').Text as typeof import('react-native').Text;
  return (
    <Text selectable={selectable} style={style}>
      {text}
    </Text>
  );
}

const styles = StyleSheet.create(() => ({
  container: {
    flex: 1,
    minHeight: 0,
  },
  nativeOverlayFallback: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 100000,
    elevation: 100000,
  },
  scrollView: {
    flex: 1,
  },
  content: {
    flexGrow: 1,
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
  logo: {
    width: 300,
    height: 90,
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
}));
