import { Platform } from 'react-native';

import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useSetting } from '@/sync/domains/state/storage';
import { getFileLanguageFromPath } from '@/scm/utils/filePresentation';

import type { CodeLinesSyntaxHighlightingMode } from './resolveCodeLinesSyntaxHighlightingConfig';
import { resolveCodeLinesSyntaxHighlightingMode } from './resolveCodeLinesSyntaxHighlightingConfig';

export type CodeLinesSyntaxHighlightingConfig = Readonly<{
    mode: CodeLinesSyntaxHighlightingMode;
    language: string | null;
    maxBytes: number;
    maxLines: number;
    maxLineLength: number;
}>;

export function useCodeLinesSyntaxHighlighting(filePath: string | null): CodeLinesSyntaxHighlightingConfig {
    const featureEnabled = useFeatureEnabled('files.diffSyntaxHighlighting');
    const advancedFeatureEnabled = useFeatureEnabled('files.syntaxHighlighting.advanced');

    const requestedMode = useSetting('filesDiffSyntaxHighlightingMode') as CodeLinesSyntaxHighlightingMode;
    const maxBytes = useSetting('filesDiffTokenizationMaxBytes');
    const maxLines = useSetting('filesDiffTokenizationMaxLines');
    const maxLineLength = useSetting('filesDiffTokenizationMaxLineLength');

    const language = filePath ? getFileLanguageFromPath(filePath) : null;

    const mode = resolveCodeLinesSyntaxHighlightingMode({
        featureEnabled: featureEnabled === true,
        requestedMode,
        advancedFeatureEnabled: advancedFeatureEnabled === true,
        platformOS: Platform.OS,
    });

    return {
        mode,
        language,
        maxBytes,
        maxLines,
        maxLineLength,
    };
}

