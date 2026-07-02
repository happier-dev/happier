import { useRouter } from 'expo-router';
import { useUnistyles } from 'react-native-unistyles';

type SettingsBelowFoldSectionsRouter = ReturnType<typeof useRouter>;
type SettingsBelowFoldSectionsTheme = ReturnType<typeof useUnistyles>['theme'];

export type SettingsBelowFoldSectionsProps = Readonly<{
    appVersion: string;
    attachmentsUploadsEnabled: boolean;
    automationsNeedLocalEnablement: boolean;
    connectedServicesEnabled: boolean;
    devModeEnabled: boolean;
    executionRunsEnabled: boolean;
    handleGitHub: () => void | Promise<void>;
    handleReportIssue: () => void | Promise<void>;
    handleVersionClick: () => void;
    mcpServersEnabled: boolean;
    memorySearchEnabled: boolean;
    promptsLibraryEnabled: boolean;
    router: SettingsBelowFoldSectionsRouter;
    showAutomations: boolean;
    showChangelog: boolean;
    showFilesAndSourceControlGroup: boolean;
    showRateUs: boolean;
    sourceControlEnabled: boolean;
    stage: number;
    terminalUseTmux: boolean | null | undefined;
    theme: SettingsBelowFoldSectionsTheme;
    useProfiles: boolean | null | undefined;
    voiceEnabled: boolean;
}>;
