import { lazyActionSpecArray } from '../../lazyActionSpecValue.js';
import { redactObservationInputPaths } from '../observationRedaction.js';
import { MANAGED_GITHUB_APP_ACTION_IDS_V1, MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1, MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1, MANAGED_GITHUB_APP_ACTION_PATHS_V1, type ManagedGitHubAppActionIdV1 } from '../../../identity/githubApps.js';
import type { PreNormalizedActionSpec } from '../definition.js';


export const MANAGED_GITHUB_APP_ACTION_SPECS: PreNormalizedActionSpec[] = lazyActionSpecArray(() => MANAGED_GITHUB_APP_ACTION_IDS_V1.map(
  (id): PreNormalizedActionSpec => {
    const metadata: Readonly<Record<ManagedGitHubAppActionIdV1, Readonly<{
      title: string;
      description: string;
      safety: 'safe' | 'danger';
      sideEffectClass: 'read' | 'danger';
      cliPath: readonly string[];
    }>>> = {
      'identity.githubApps.list': {
        title: 'List managed GitHub Apps',
        description: 'List the managed GitHub App registrations visible to one Home or Team owner.',
        safety: 'safe',
        sideEffectClass: 'read',
        cliPath: ['identity', 'github-apps', 'list'],
      },
      'identity.githubApps.create': {
        title: 'Create managed GitHub App',
        description: 'Create a managed GitHub App registration for one Home or Team owner.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'create'],
      },
      'identity.githubApps.manifestSetup.start': {
        title: 'Start GitHub App manifest setup',
        description: 'Create a one-time GitHub.com App manifest handoff for one Home or Team owner.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'manifest-setup', 'start'],
      },
      'identity.githubApps.update': {
        title: 'Update managed GitHub App',
        description: 'Update a managed GitHub App registration and rotate its write-only secrets.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'update'],
      },
      'identity.githubApps.verifyInstallation': {
        title: 'Verify managed GitHub App installation',
        description: 'Verify and bind an exact GitHub App installation and organization.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'verify-installation'],
      },
      'identity.githubApps.remove': {
        title: 'Remove managed GitHub App installation',
        description: 'Remove an unused managed GitHub App installation at its current revision.',
        safety: 'danger',
        sideEffectClass: 'danger',
        cliPath: ['identity', 'github-apps', 'remove'],
      },
    };
    const row = metadata[id];
    // `list` returns the already-redacted registration/installation projection
    // and is the one managed-App operation an automation caller may carry. Every
    // other row either accepts write-only App key material or answers with a
    // one-time browser handoff, so it stays on an authenticated human caller —
    // withholding the Agent tool surface alone would still leave the same spec
    // reachable to an API-token or trusted-plugin caller through the public ABI.
    const isSafeRead = id === 'identity.githubApps.list';
    return {
      id, approval: { result: 'required' },
      ...(['identity.githubApps.remove', 'identity.githubApps.create', 'identity.githubApps.manifestSetup.start',
        'identity.githubApps.verifyInstallation'].includes(id)
        ? { approvalPolicy: { uiConfirmation: 'direct' as const } } : {}),
      ...(id === 'identity.githubApps.update' ? { approvalPolicy: {
        uiConfirmation: 'direct' as const,
        uiConfirmationForInput: (input: unknown) => {
          const parsed = MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1['identity.githubApps.update'].safeParse(input);
          // Metadata is reversible; replaced or cleared write-only keys cannot
          // be restored from the Home's redacted registration projection.
          return !parsed.success || Object.keys(parsed.data.patch.secrets ?? {}).length > 0;
        },
      } } : {}),
      title: row.title,
      description: row.description,
      safety: row.safety,
      requiredAuthority: isSafeRead ? 'account_automation' : 'present_user',
      executionPlacement: 'account',
      placements: [],
      surfaces: {
        ui: true,
        voice: false,
        agent: isSafeRead,
        mcp: false,
        cli: true,
        rpc: false,
      },
      sideEffectClass: row.sideEffectClass,
      inputSchema: MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1[id],
      outputSchema: MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[id],
      inputHints: { fields: [] },
      // Registration and installation state belong to one exact Home. The
      // selector is required so credential lookup cannot borrow the device's
      // ambient active Home for a managed-identity secret owner.
      cli: {
        commands: [{ path: [...row.cliPath], visibility: 'canonical' }],
        acceptsServerId: true,
        requiresServerId: true,
      },
      // App private keys, client secrets and webhook secrets are write-only.
      // Observation reaches every installed plugin's after-hook, so the secret
      // arm is dropped here rather than at each observer.
      ...(id === 'identity.githubApps.create'
        ? { projectObservationInput: redactObservationInputPaths('secrets') }
        : {}),
      ...(id === 'identity.githubApps.update'
        ? { projectObservationInput: redactObservationInputPaths('patch.secrets') }
        : {}),
      // The manifest-setup link carries a one-time launch handle and the
      // installation verification answers with a live OAuth authorize URL plus
      // its attempt id. Both are scoped one-time browser credentials, so the
      // observation the executor hands to every installed plugin's after-hook
      // and to the durable approval record keeps only the fact that a handoff
      // was produced — the same projection the sibling provider-test and Admin
      // Portal handoffs use.
      ...(id === 'identity.githubApps.manifestSetup.start' || id === 'identity.githubApps.verifyInstallation'
        ? { projectObservationOutput: () => ({ redacted: true }) }
        : {}),
      serverTransport: { method: 'POST', path: MANAGED_GITHUB_APP_ACTION_PATHS_V1[id] },
    };
  },
));
