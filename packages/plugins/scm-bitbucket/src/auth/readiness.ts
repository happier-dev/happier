export type BitbucketAuthReadinessState =
  | 'ready'
  | 'missing_descriptor'
  | 'missing_email'
  | 'missing_token'
  | 'invalid_host'
  | 'invalid_workspace'
  | 'api_probe_unavailable';

export type BitbucketAuthReadinessInput = Readonly<{
  descriptorMaterializationKinds: readonly string[];
  host: string;
  workspaceOrTeam: string;
  username: string | null;
  apiTokenAvailable: boolean;
  apiProbe: 'available' | 'unavailable';
}>;

export type BitbucketAuthReadiness = Readonly<{
  state: BitbucketAuthReadinessState;
  diagnostic: string;
  remediation: string | null;
}>;

function normalizeHost(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return new URL(trimmed.includes('://') ? trimmed : `https://${trimmed}`).hostname.toLowerCase();
  } catch {
    return trimmed.toLowerCase();
  }
}

function redactedUsername(_value: string | null): string {
    return 'configured account';
}

export function resolveBitbucketAuthReadiness(input: BitbucketAuthReadinessInput): BitbucketAuthReadiness {
  if (!input.descriptorMaterializationKinds.includes('scm_hosting_basic_auth')) {
    return {
      state: 'missing_descriptor',
      diagnostic: 'Bitbucket Cloud API credentials are not available from connected-account descriptors.',
      remediation: 'Connect Bitbucket with your Atlassian account email plus API token.',
    };
  }
  if (normalizeHost(input.host) !== 'bitbucket.org') {
    return {
      state: 'invalid_host',
      diagnostic: 'Bitbucket Server and Data Center hosts are not supported by this V1 credential descriptor.',
      remediation: 'Use a Bitbucket Cloud remote on bitbucket.org.',
    };
  }
  if (!input.workspaceOrTeam.trim()) {
    return {
      state: 'invalid_workspace',
      diagnostic: 'Bitbucket Cloud workspace or team metadata is missing from the remote.',
      remediation: 'Use a Bitbucket Cloud remote with a workspace and repository path.',
    };
  }
  if (!input.username?.trim()) {
    return {
      state: 'missing_email',
      diagnostic: 'Bitbucket Cloud credentials are missing an Atlassian account email.',
      remediation: 'Reconnect Bitbucket and enter the Atlassian account email the API token belongs to.',
    };
  }
  if (!input.apiTokenAvailable) {
    return {
      state: 'missing_token',
      diagnostic: 'Bitbucket Cloud credentials are missing an API token.',
      // App passwords were disabled on 2026-06-09 and no longer work, so the remediation
      // must never send a reader to one.
      remediation: 'Reconnect Bitbucket with an Atlassian API token.',
    };
  }
  if (input.apiProbe === 'unavailable') {
    return {
      state: 'api_probe_unavailable',
      diagnostic: 'Bitbucket Cloud credentials are configured, but API readiness could not be probed.',
      remediation: 'Retry later or verify the API token in Bitbucket account settings.',
    };
  }
  return {
    state: 'ready',
    diagnostic: `Bitbucket Cloud API credentials are configured for ${redactedUsername(input.username)}.`,
    remediation: null,
  };
}
