import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

type SettingsBelowFoldSectionsRouter = ReturnType<typeof useRouter>;
type SettingsBelowFoldSectionsTheme = ReturnType<typeof useUnistyles>['theme'];

export type SettingsBelowFoldSectionsProps = Readonly<{
    appVersion: string;
    automationsNeedLocalEnablement: boolean;
    devModeEnabled: boolean;
    handleGitHub: () => void | Promise<void>;
    handleReportIssue: () => void | Promise<void>;
    handleVersionClick: () => void;
    /** Preserves host navigation behavior when the catalog renders a generic root group. */
    onNavigate?: (route: string) => void | Promise<void>;
    router: SettingsBelowFoldSectionsRouter;
    showAutomations: boolean;
    showChangelog: boolean;
    showRateUs: boolean;
    stage: number;
    terminalUseTmux: boolean | null | undefined;
    theme: SettingsBelowFoldSectionsTheme;
}>;
