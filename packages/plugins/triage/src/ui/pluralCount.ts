import * as React from 'react';
import { usePluginTranslation, useSurfaceContext } from '@happier-dev/plugin-ui';

/** A count sentence: the catalog key under `plugins.triage.`, the count, and its English one/other forms. */
export type TriagePluralCountV1 = (
  key: string,
  count: number,
  english: Readonly<{ one: string; other: string }>,
) => string;

/** A count sentence in the reader's plural form, from 'plugins.triage.<key>.<form>' then its '.other', then English. */
export function useTriagePluralCount(): TriagePluralCountV1 {
  const text = usePluginTranslation();
  const { locale } = useSurfaceContext();
  const rules = React.useMemo(() => {
    try {
      return new Intl.PluralRules(locale);
    } catch {
      return new Intl.PluralRules('en');
    }
  }, [locale]);
  return React.useCallback(
    (key, count, english) => {
      const values = { count: String(count) };
      const form = rules.select(count);
      const other = text(`plugins.triage.${key}.other`, english.other, values);
      return form === 'other'
        ? other
        : text(`plugins.triage.${key}.${form}`, form === 'one' ? english.one : other, values);
    },
    [rules, text],
  );
}
