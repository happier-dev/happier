import * as React from 'react';

import type { Profile } from '@/sync/domains/profiles/profile';
import { getLinkedProvider } from '@/sync/domains/profiles/profile';

export function useBugReportReporterGithubUsername(profile: Profile): {
  reporterGithubUsername: string;
  setReporterGithubUsername: (value: string) => void;
} {
  const touched = React.useRef(false);
  const githubLinkedProvider = React.useMemo(() => getLinkedProvider(profile, 'github'), [profile]);
  const defaultValue = githubLinkedProvider?.login ? `@${githubLinkedProvider.login}` : '';
  const [state, setState] = React.useState('');

  React.useEffect(() => {
    if (!touched.current) {
      setState(defaultValue);
    }
  }, [defaultValue]);

  const setReporterGithubUsername = React.useCallback((value: string) => {
    touched.current = true;
    setState(value);
  }, []);

  return {
    reporterGithubUsername: state,
    setReporterGithubUsername,
  };
}
