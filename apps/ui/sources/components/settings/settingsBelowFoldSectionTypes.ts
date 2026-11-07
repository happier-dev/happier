import { useRouter } from '@/components/appShell/workspace/destinationRoute';

type SettingsBelowFoldSectionsRouter = ReturnType<typeof useRouter>;

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
    /** The unfinished "Support us" entry, shown only in developer mode. */
    supportUs: Readonly<{ subtitle: string; onPress: () => void }> | null;
}>;
