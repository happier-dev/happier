import * as React from 'react';
import { HappierFindBar, usePluginTheme, usePluginTranslation } from '@happier-dev/plugin-ui';
import { useHappierUiAccessibility, useOptionalHappierUiPalette } from '@happier-dev/plugin-ui/environment';
import type { ForgeCiLogFindControllerV1 } from '../findController.js';

/** The shared Find chrome bound to the selected log's existing controller. */
export function ForgeCiLogFindBar(props: Readonly<{
  controller: ForgeCiLogFindControllerV1;
  onInputFocus(): void;
  onInputBlur(): void;
}>) {
  const t = usePluginTranslation();
  const theme = usePluginTheme();
  const palette = useOptionalHappierUiPalette(theme);
  const accessibility = useHappierUiAccessibility();
  const { controller } = props;
  return <HappierFindBar
    query={controller.query} options={controller.options} status={controller.status} capabilities={controller.capabilities}
    onQueryChange={controller.setQuery} onOptionsChange={controller.setOptions} onStep={controller.step}
    onStop={controller.stop} onClose={controller.close}
    onInputFocus={props.onInputFocus} onInputBlur={props.onInputBlur}
    presentation="inline" reducedMotion={accessibility.reducedMotion}
    labels={{
      field: t('forgeCi.log.find', 'Find in this job’s log'),
      previous: t('happier.find.previous', 'Previous match'), next: t('happier.find.next', 'Next match'),
      matchCase: t('happier.find.matchCase', 'Match case'), regex: t('happier.find.regex', 'Use regular expression'),
      regexShort: t('happier.find.regexShort', 'Regular expression'), options: t('happier.find.options', 'Match options'),
      close: t('happier.find.close', 'Close find'), done: t('happier.find.done', 'Done'), stop: t('happier.find.stop', 'Stop'),
      noMatches: t('happier.find.noMatches', 'No matches'), noneFound: t('happier.find.noneFound', 'None found'),
      invalidPattern: t('happier.find.invalidPattern', 'Invalid pattern'), offline: t('happier.find.offline', 'Offline'),
      unsupported: t('happier.find.unsupported', 'Not searchable'),
      count: (current, total) => current === null ? t('happier.find.matches', '{total} matches', { total })
        : t('happier.find.count', '{current} of {total}', { current, total }),
      files: files => t('happier.find.files', '{files} files', { files }),
      soFar: t('happier.find.soFar', 'so far'), loaded: t('happier.find.loaded', 'loaded'),
    }}
    colors={{ surface: palette?.sheet ?? theme.colors.surface, ring: palette?.controlBorder ?? theme.colors.border,
      field: palette?.fieldBackground ?? theme.colors.control, text: theme.colors.text,
      secondaryText: theme.colors.secondaryText, tertiaryText: theme.colors.mutedText, divider: theme.colors.divider,
      accent: theme.colors.accent, accentFill: theme.colors.control, danger: theme.colors.danger,
      hover: palette?.navigationHover ?? theme.colors.control, pressed: theme.colors.control, focus: theme.colors.focus,
    }}
  />;
}
