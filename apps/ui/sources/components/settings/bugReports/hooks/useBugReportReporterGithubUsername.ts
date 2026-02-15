import * as React from 'react';

import type { Profile } from '@/sync/domains/profiles/profile';
import { getLinkedProvider, profileDefaults } from '@/sync/domains/profiles/profile';

export function useBugReportReporterGithubUsername(profile: Profile | null): {
	  reporterGithubUsername: string;
	  setReporterGithubUsername: (value: string) => void;
	} {
	  const touched = React.useRef(false);
	  const resolvedProfile = profile ?? profileDefaults;
	  const githubLinkedProvider = React.useMemo(() => getLinkedProvider(resolvedProfile, 'github'), [resolvedProfile]);
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
