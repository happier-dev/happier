import * as React from 'react';

import { usePortableHomeLinkTarget } from '@/components/teams/join/teamJoinTarget';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { projectSourceSetupRoute, readProjectSourceSetupSelection } from './projectSourceNavigation';

/** Source links consume the existing Home and credential owners; focus never selects their Account. */
export function useProjectSourceSetupTarget(params: Parameters<typeof readProjectSourceSetupSelection>[0]) {
  const selection = React.useMemo(() => readProjectSourceSetupSelection(params), [params.source, params.target]);
  const target = usePortableHomeLinkTarget(selection?.homeTarget);
  const credentials = useServerCredentialAccountScopeBinding(target.kind === 'resolved' ? target.serverId : null);
  const returnTo = selection ? projectSourceSetupRoute(selection) : null;
  return { selection, target, credentials, returnTo };
}
