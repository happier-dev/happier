import { z } from 'zod/mini';
import { isRecord } from '../common/records.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { projectActionFailureRecoveryV1 } from '../actions/actionExecutionResult.js';

/** The fallback names the unavailable result, never an invented provider prerequisite. */
export const DeploymentFailureRecoveryV1Schema = lazyZodSchema(() => z.strictObject({
    requiredFact: z.literal('deploymentActionResult'),
    remedy: z.string().check(z.trim(), z.minLength(1)),
}));

/** Presentation intents open existing editors/readers; they never execute or retry a mutation.
 * `source` opens the deployment's existing Source detail, including Repository and checkouts.
 */
export type DeploymentFailureRecoveryDestinationV1 =
    | 'source' | 'domains' | 'variables' | 'permissions' | 'settings' | 'history' | 'logs'
    | 'machines' | 'buildMachineSetup' | 'connectedAccounts' | 'store' | 'review';
export type DeploymentFailureRecoveryNextActionV1 = Readonly<{
    kind: 'navigate'; destination: DeploymentFailureRecoveryDestinationV1; label: string;
}>;
export type DeploymentFailureRecoveryPresentationV1 = Readonly<{
    requiredFact: string; remedy: string; nextAction: DeploymentFailureRecoveryNextActionV1;
}>;

function recovery(remedy: string, destination: DeploymentFailureRecoveryDestinationV1, label: string) {
    return { remedy, nextAction: { kind: 'navigate' as const, destination, label } };
}

// Read-only presentation, never persisted into strict receipts or approval details.
// Keep diagnostic codes out of the prose; all surfaces consume this one owner.
const recoveries = {
    build_platform_unsupported: recovery('The build Machine could not execute a platform required by this build. Open its Setup and check Build emulation, or choose a capable build Machine in Environment Settings. Emulated builds are slower.', 'buildMachineSetup', 'Open build Machine Setup'),
    native_build_failed: recovery('The image build failed. Read its build output to fix the reported command or executable before deploying again.', 'logs', 'Open build output'),
    deployment_source_unavailable: recovery('Open Source details and set the Repository address and default branch or revision. Then open or accept its checkout on the selected Machine. Choose a revision containing your Compose file, then review the deployment again.', 'source', 'Open Source details'),
    required_fact_unavailable: recovery("Happier could not confirm the deployment's current state. Open its history to check what ran before trying again.", 'history', 'Review deployment history'),
    template_domain_route_required: recovery('This app needs a route for its address. Choose how to reach it, or leave the address out if the template makes it optional.', 'domains', 'Choose address'),
    template_domain_required: recovery('This template requires an address. Choose one in the app setup before installing.', 'domains', 'Set required address'),
    template_domain_unknown: recovery('A supplied address is not declared by this template. Remove it or reload the template setup.', 'domains', 'Review addresses'),
    unsupported_domain: recovery('This template describes an address that Happier cannot set up. Review its address settings or choose another template.', 'domains', 'Review address'),
    native_route_unavailable: recovery('The address could not be connected to the app. Check its service, port, and serving machines, then verify the address again.', 'domains', 'Check route'),
    port_in_use: recovery('Another service is using the address port. Stop that service or choose a tunnel for this address, then review it again.', 'domains', 'Change address route'),
    native_effect_failed: recovery('The machine could not apply the address change. Check the current route before trying the change again.', 'domains', 'Check address change'),
    private_scope_unenforceable: recovery('The selected route cannot keep this address private. Choose a route that supports private access.', 'domains', 'Choose private route'),
    deployment_conflict: recovery('The Environment changed since this review. Open a fresh review to include the latest changes.', 'review', 'Review latest changes'),
    deployment_access_denied: recovery('You do not have permission to change this Environment. Ask its owner for deployment access.', 'permissions', 'View permissions'),
    machine_unavailable: recovery('A required machine is unavailable. Reconnect it or choose another machine for this Environment.', 'machines', 'Check machines'),
    secret_missing: recovery('A required secret is missing. Add it to this Environment before deploying again.', 'variables', 'Add missing secret'),
    template_source_unavailable: recovery('The app template could not be loaded. Reconnect its registry or choose an available template.', 'store', 'Open app source'),
    template_changed: recovery('The template changed since you opened it. Reload the app listing and review the current version.', 'store', 'Reload app listing'),
    deployment_failed: recovery('The deployment failed. Open its build and service logs, fix the reported cause, then deploy again.', 'logs', 'Open deployment logs'),
    database_transaction_conflict_exhausted: recovery('The Home was too busy to record the result, so it is not known whether the change took effect. Check deployment history and the running app before trying again.', 'history', 'Check change outcome'),
    outcome_unknown: recovery('Happier lost confirmation of the change. Check deployment history and the running app before starting another change.', 'history', 'Check change outcome'),
    unsupported_action: recovery('This target does not support the requested change. Review the linked target and choose a supported operation.', 'settings', 'Review target'),
    unsupported: recovery('This deployment option is not supported by the selected target. Choose a compatible target or option.', 'settings', 'Change deployment option'),
    deployment_unavailable: recovery('This Environment or deployment is no longer available. Open its history to choose an available deployment.', 'history', 'Find deployment'),
    deployment_content_unavailable: recovery('The saved deployment definition could not be opened. Reconnect its source and review the definition again.', 'source', 'Open deployment source'),
    deployment_invalid: recovery('The deployment settings could not be accepted. Review the highlighted settings before submitting again.', 'review', 'Review deployment settings'),
    deployment_teardown_required: recovery('This Environment still has running resources. Review Stop and remove before deleting it.', 'settings', 'Review Stop and remove'),
    deployment_in_progress: recovery('A deployment is already running for this Environment. Wait for it to finish, or open its history and use Stop before trying again.', 'history', 'Open running deployment'),
    deployment_executor_unavailable: recovery('The deployment controller is not available. Reconnect its machine or choose another controller.', 'machines', 'Check controller'),
    deployment_target_role_unavailable: recovery('The linked target cannot perform this deployment step. Review its setup and supported operations.', 'settings', 'Check linked target'),
    deployment_generation_required: recovery('This app still needs its deployment files. Open the source and finish generating them before deploying.', 'source', 'Prepare deployment files'),
    deployment_image_unavailable: recovery('The prepared app image is unavailable. Check the build logs and build the app again.', 'logs', 'Check app build'),
    deployment_activation_not_observed: recovery('Happier could not confirm that the new app started. Check the service logs and running app before redeploying.', 'logs', 'Check app startup'),
    deployment_log_unavailable: recovery('The deployment logs could not be read. Reconnect the serving machine and open the logs again.', 'machines', 'Reconnect log source'),
    deployment_read_failed: recovery('The Environment could not be read. Reconnect its controller and reload the Environment.', 'machines', 'Reconnect controller'),
    deployment_source_data_kept: recovery('The app stopped, but its source data was kept. Review the retained data before removing it yourself.', 'settings', 'Review retained data'),
    repository_required: recovery('This deployment needs a repository. Choose one for the project before deploying.', 'source', 'Choose repository'),
    needs_repository: recovery('The selected operation needs repository files. Link a repository source and review the operation again.', 'source', 'Link repository'),
    source_access_denied: recovery('You cannot manage the selected project source. Ask its owner for access or choose a source you can manage.', 'source', 'Review source access'),
    source_changed: recovery('The project source changed after preparation. Reload it and review the deployment from the current source.', 'source', 'Reload project source'),
    source_identity_mismatch: recovery('The source no longer matches the reviewed repository. Choose the intended repository and prepare a new review.', 'source', 'Check repository'),
    target_mismatch: recovery('The selected machine or target no longer matches this review. Choose the intended target and review again.', 'settings', 'Choose target'),
    target_unavailable: recovery('The selected target is unavailable. Reconnect it or link another target to this Environment.', 'settings', 'Open targets'),
    client_required: recovery('This change needs a connected Happier client. Open the Environment on a connected device to continue.', 'machines', 'Check connected machines'),
    home_unreachable: recovery('Happier cannot reach this Home. Reconnect to the Home, then reload the Environment.', 'machines', 'Check Home connection'),
    host_retired: recovery('The machine connection changed while this review was open. Reconnect it and open a fresh review.', 'machines', 'Reconnect machine'),
    action_account_scope_changed: recovery('The active Account changed. Reopen this Environment in the Account that owns the review.', 'review', 'Reopen deployment review'),
    server_scope_mismatch: recovery('This review belongs to another Home. Open the Environment in that Home and review the change there.', 'review', 'Check review Home'),
    notice_account_scope_mismatch: recovery('This notification belongs to another Account. Switch to that Account before opening the deployment.', 'review', 'Open deployment review'),
    action_forbidden: recovery('This change is not permitted with your current access. Ask the Environment or machine owner for the needed permission.', 'permissions', 'Check access'),
    action_not_allowed: recovery('Your approval settings do not allow this deployment action. Review the permissions with the owner before continuing.', 'permissions', 'Review action permissions'),
    credential_scope_denied: recovery('The connected account is not allowed to perform this change. Choose an account with the required access.', 'connectedAccounts', 'Choose connected account'),
    connected_account_required: recovery('This target needs a connected account. Connect the service account used for this deployment.', 'connectedAccounts', 'Connect service account'),
    unsupported_credential_role: recovery('The selected account cannot fill this deployment role. Choose an account that supports the target.', 'connectedAccounts', 'Review service account'),
    admin_access_unavailable: recovery('The machine needs administrator access for this change. Review its administrator connection before retrying.', 'machines', 'Review administrator access'),
    machine_admin_access_required: recovery('This address change needs administrator permission on the machine. Review its administrator access before adding the address.', 'machines', 'Set up administrator access'),
    machine_network_review_required: recovery('The machine network needs review before this address can be added. Review its network access and how the address reaches the app.', 'machines', 'Review machine network'),
    agent_isolation_unavailable: recovery('The machine cannot start the required isolated process. Check its agent setup before deploying.', 'machines', 'Check machine setup'),
    approval_stale: recovery('This approval no longer describes the current deployment. Open a new review before approving.', 'review', 'Create fresh review'),
    changed_since_review: recovery('The reviewed inputs have changed. Review the updated change before continuing.', 'review', 'Review updated inputs'),
    stale_input: recovery('The prepared deployment inputs are out of date. Prepare and review the deployment again.', 'review', 'Prepare fresh review'),
    action_interactive_review_required: recovery('This change needs your review. Open the deployment review and confirm the proposed changes.', 'review', 'Open required review'),
    approvals_not_supported: recovery('This entry point cannot request the approval this change needs. Open the deployment in Happier to review it.', 'review', 'Review in Happier'),
    admission_unavailable: recovery('Happier could not prepare this change for approval. Check the machine connection, then open a new review.', 'machines', 'Check review connection'),
    service_admission_unavailable: recovery('The service could not be prepared on the machine. Check its service setup before reviewing again.', 'machines', 'Check service setup'),
    authority_changed: recovery('The access used for this review changed. Review permissions and prepare the change again.', 'permissions', 'Review changed access'),
    deployment_child_binding_mismatch: recovery('A deployment step no longer matches the approved change. Start a fresh review of the complete deployment.', 'review', 'Review complete deployment'),
    deployment_child_custody_missing: recovery('The machine could not open the approved deployment files. Reconnect the source and prepare a new review.', 'source', 'Reconnect approved source'),
    filesystem_transfer_custody_required: recovery('The target cannot access the reviewed source files. Reconnect the source machine and prepare the deployment again.', 'source', 'Check source machine'),
    cancelled: recovery('The deployment was stopped. Check which steps completed before deciding whether to deploy again or roll back.', 'history', 'Review stopped deployment'),
    rollback_image_unavailable: recovery('The selected rollback image is no longer available. Choose another retained deployment or build the source again.', 'history', 'Choose rollback deployment'),
    backup_required: recovery('This change requires a backup first. Configure and run a backup before reviewing the change again.', 'settings', 'Set up backup'),
    backup_failed: recovery('The backup failed. Check the backup destination and credentials before running it again.', 'settings', 'Check backup settings'),
    backup_integrity_failed: recovery('The backup could not be verified. Check its details and choose a verified backup before restoring.', 'settings', 'Review backup verification'),
    restore_prepare_required: recovery('This restore needs a fresh review of the backup and destination. Prepare the restore again.', 'settings', 'Prepare restore'),
    restore_failed: recovery('The data restore failed. Review the restore result before restarting the app or attempting another restore.', 'history', 'Review restore result'),
    active_backup_automation: recovery('A backup automation still uses this configuration. Update or pause it before removing the configuration.', 'settings', 'Review backup automation'),
    active_backup_configuration: recovery('A backup configuration still uses this destination. Update it before removing the destination.', 'settings', 'Review backup destination'),
    invalid_backup_configuration: recovery('The backup configuration is incomplete or invalid. Review its repository, destination, and credentials.', 'settings', 'Edit backup configuration'),
    repository_locked: recovery('Another backup operation is using the repository. Wait for it to finish, then run this operation again.', 'settings', 'Check backup operations'),
    repository_password_incorrect: recovery('The backup repository rejected its password. Update the saved credential before trying again.', 'settings', 'Update backup credential'),
    secret_binding_required: recovery('A deployment value needs a saved secret. Choose a secret for the value before continuing.', 'variables', 'Choose saved secret'),
    personal_secret_requires_promotion: recovery('This shared Environment needs a shared secret. Promote the personal secret or choose a shared one.', 'variables', 'Review secret sharing'),
    reference_unavailable: recovery('A referenced deployment value is unavailable. Choose an available variable or secret.', 'variables', 'Repair variable reference'),
    template_variable_required: recovery('The app needs a value that has not been filled in. Complete its required variables before installing.', 'variables', 'Fill required variables'),
    template_secret_reference_required: recovery('An app secret must come from a saved secret. Choose one instead of entering a plain value.', 'variables', 'Select app secret'),
    template_binding_unknown: recovery('A supplied variable is not declared by this template. Remove that value or reload the template setup.', 'variables', 'Review template variables'),
    template_binding_conflict: recovery('The template would replace a value you already changed. Review the conflicting value and choose what to keep.', 'variables', 'Resolve variable conflict'),
    template_generator_undeclared: recovery('The template requests a secret generator it does not declare. Ask the template author to fix it or choose another template.', 'store', 'Review app template'),
    template_needs_review: recovery('This app template needs review before it can be installed. Review the reported unsupported settings or choose another app.', 'store', 'Review app requirements'),
    template_resource_conflict: recovery('The template conflicts with existing deployment files or resources. Review the differences before applying it.', 'source', 'Resolve resource conflict'),
    template_service_conflict: recovery('The template would replace an existing service. Review the service changes and choose what to keep.', 'source', 'Resolve service conflict'),
    provider_scope_already_linked: recovery('This platform project is already linked to an Environment. Open the existing link or choose another platform project.', 'settings', 'Review platform links'),
    provider_response_invalid: recovery('The platform returned a response Happier could not read. Check the connected account and reload the platform choices.', 'connectedAccounts', 'Check platform account'),
    provider_unavailable: recovery('The deployment platform is unavailable. Check its connection before loading the target again.', 'connectedAccounts', 'Check platform connection'),
    plugin_exec_system_tool_unavailable: recovery('A required deployment tool is missing on the machine. Open its setup to install or repair the tool.', 'machines', 'Repair deployment tools'),
    plugin_exec_executable_denied: recovery('The machine refused to run a required deployment tool. Review its execution permissions with the machine owner.', 'machines', 'Review tool access'),
    native_service_control_unconfirmed: recovery('The machine did not confirm the service change. Check the running services before issuing another change.', 'machines', 'Check running services'),
    native_failed: recovery('A machine operation failed. Open the deployment logs to find the failed step before trying again.', 'logs', 'Inspect failed step'),
    service_unavailable: recovery('A required service is unavailable on the machine. Check its status and setup before continuing.', 'machines', 'Check required service'),
    service_operation_unavailable: recovery('The machine could not find the service operation. Check its service status before starting another operation.', 'machines', 'Find service operation'),
    operation_unavailable: recovery('The deployment operation is unavailable. Open deployment history to find its recorded result.', 'history', 'Find operation result'),
    action_operation_unavailable: recovery('The tracked action could not be opened. Check deployment history before submitting the same change again.', 'history', 'Find tracked change'),
    volume_observation_unavailable: recovery('The machine could not list the app data volumes. Reconnect it and reopen Stop and remove to review the data.', 'machines', 'Check data machine'),
    volume_removal_failed: recovery('Some app data volumes could not be removed. Review the remaining data before trying removal again.', 'settings', 'Review remaining volumes'),
    invalid_parameters: recovery('Some deployment choices could not be accepted. Open the review and correct the highlighted inputs.', 'review', 'Correct deployment choices'),
    invalid_action_output: recovery('Happier could not read the result of the deployment step. Check history and the running app before repeating it.', 'history', 'Check recorded result'),
    invalid_action_transport_output: recovery('The machine returned an unreadable deployment result. Reconnect it and check history before repeating the change.', 'history', 'Check machine result'),
    invalid_destination_config: recovery('The deployment destination is not configured correctly. Review its target settings before continuing.', 'settings', 'Edit destination'),
    destination_changed: recovery('The destination changed after this review. Choose the intended destination and review again.', 'settings', 'Review changed destination'),
    environment_mismatch: recovery('This operation refers to a different Environment. Reopen the intended Environment and review the change there.', 'review', 'Check Environment'),
    health_check_subject_unavailable: recovery('The health check cannot find the deployed service. Review its service and address selection.', 'settings', 'Review health check'),
    project_defaults_unavailable: recovery('The project deployment defaults could not be loaded. Reconnect the source and reopen setup.', 'source', 'Reload project defaults'),
    project_defaults_content_unavailable: recovery('The saved project defaults could not be opened. Check source access and load them again.', 'source', 'Open project defaults'),
    project_defaults_conflict: recovery('The project defaults changed during setup. Reload them and review your deployment choices.', 'review', 'Review project defaults'),
    project_defaults_scope_mismatch: recovery('These defaults belong to another project. Select the intended project source before continuing.', 'source', 'Choose project source'),
    account_settings_unavailable: recovery('Your deployment preferences could not be loaded. Check the Home connection and reopen setup.', 'machines', 'Check preferences connection'),
    registry_config_cleanup_failed: recovery('The temporary registry configuration could not be removed. Check the machine before starting another deployment.', 'machines', 'Check registry cleanup'),
    requester_authority_unavailable: recovery('The requester could not be confirmed. Reconnect the original session and submit the request again.', 'review', 'Review original request'),
    session_requester_unavailable: recovery('The session requester is unavailable. Reopen the original session before requesting the deployment again.', 'review', 'Open original session'),
    requester_workspace_requires_owner: recovery('This request cannot use the selected workspace. Choose a source machine you are authorized to use.', 'source', 'Choose authorized source'),
    endpoint_unavailable: recovery('The deployment connection is unavailable. Reconnect the controller machine and reload the Environment.', 'machines', 'Check deployment connection'),
    invalid_request: recovery('The deployment request is incomplete. Reopen the review and complete the required choices.', 'review', 'Complete deployment request'),
    invalid_response: recovery('The deployment returned an unreadable response. Check its recorded result before repeating the request.', 'history', 'Review deployment response'),
    invalid_value: recovery('A deployment value could not be accepted. Review the highlighted value and correct it before continuing.', 'review', 'Correct deployment value'),
    not_found: recovery('A selected deployment item is no longer available. Reload the review and choose an available item.', 'review', 'Reload deployment choices'),
    outside_root: recovery('The deployment files extend outside the selected source folder. Choose a source folder that contains the app files.', 'source', 'Check source folder'),
    unavailable: recovery('The requested deployment information is unavailable. Open history to check the last recorded result.', 'history', 'Check last result'),
    request_headers_too_large: recovery('The deployment request was rejected because its HTTP headers were too large. Ask the Home owner to update Happier, then check deployment history before trying again.', 'history', 'Review request failure'),
    auth_failed: recovery('The service rejected the connected account. Reconnect that account before preparing the deployment again.', 'connectedAccounts', 'Reconnect service account'),
    // A referenced private service reached through the Happier network (NET-FWD's typed forward failures).
    private_service_forward_refused: recovery('The Machine sharing this service refused the private connection. Check that the service is still shared and that you can use that Machine, then deploy again.', 'variables', 'Check shared service reference'),
    private_service_destination_unreachable: recovery('The shared service is not accepting connections on its Machine. Check that it is running there, then deploy again.', 'machines', 'Check shared service'),
    machine_carrier_unavailable: recovery('Happier could not reach the other Machine over the Happier network. Check that both Machines are online, then deploy again.', 'machines', 'Check Machine connection'),
    private_service_container_bridge_unavailable: recovery("Happier could not connect this app's containers to the shared service. Check the container service on this Machine, then deploy again.", 'machines', 'Check container connection'),
} as const;

const missingFacts = {
    buildMachineId: recovery('Choose a build machine in the Environment settings, then review the deployment again.', 'settings', 'Choose build machine'),
    cloudflare_selection_required: recovery('Choose the Cloudflare account and tunnel for this address before adding it.', 'domains', 'Choose Cloudflare tunnel'),
    domain_ingress_required: recovery('Choose how this address reaches the app before adding it to an Environment with several machines.', 'domains', 'Choose address route'),
    activeDomainMembers: recovery('This address has no active serving machine. Deploy the app to a machine before adding the address.', 'settings', 'Choose serving machines'),
    memberCaddyObservation: recovery('Happier could not read the address proxy on a serving machine. Reconnect the machine and check its services.', 'machines', 'Check address proxy'),
    publicCaddyObservation: recovery('Happier could not read the public address proxy. Reconnect the edge machine and check its services.', 'machines', 'Check public proxy'),
    edgeCaddyMachine: recovery('The edge machine selected for this address is unavailable. Reconnect it or choose another route.', 'domains', 'Change edge route'),
    privateCaddyListener: recovery('The app has no usable private proxy listener. Check the serving machine proxy or choose another address route.', 'domains', 'Review private route'),
    publicCaddyListener: recovery('The edge proxy has no usable public listener. Check its proxy setup or choose a tunnel for this address.', 'domains', 'Review public route'),
    sharedTunnelOrigin: recovery('The serving machines do not share a reachable tunnel origin. Review the tunnel and the machines serving this address.', 'domains', 'Review tunnel origin'),
    cloudflarePreparation: recovery('The Cloudflare tunnel could not be prepared. Check its connected account and tunnel selection.', 'domains', 'Review Cloudflare route'),
    networkExposure: recovery('Happier could not confirm how the app is reachable. Review the machine network and the address route.', 'domains', 'Review network access'),
    reachabilityPosture: recovery('The address route does not have a confirmed network setup. Review how traffic reaches the serving machines.', 'domains', 'Check address reachability'),
    domainIngress: recovery('This address has no usable route to the app. Choose its serving machine or tunnel.', 'domains', 'Set address route'),
    managedServiceDocker: recovery('The machine container service is unavailable. Repair or start it before adding the address.', 'machines', 'Check container service'),
    nativeContainerIdentity: recovery('Happier could not identify the app container. Check the running deployment before connecting the address.', 'history', 'Check app container'),
    nativeServiceReplicas: recovery('The address has no confirmed running app instances. Check the service logs and start the app first.', 'logs', 'Check app instances'),
    routeUpstreams: recovery('The address cannot find the selected service and port. Check which service the address should reach.', 'domains', 'Choose app service'),
    caddyContainer: recovery('The address proxy container is unavailable. Check its service on the machine before verifying the address.', 'machines', 'Check proxy container'),
    caddyMountedSeed: recovery('The address proxy could not load its configuration. Repair the proxy setup on the serving machine.', 'machines', 'Repair proxy setup'),
    caddyAdminSocket: recovery('Happier cannot reach the address proxy controls. Check the proxy service on the serving machine.', 'machines', 'Check proxy connection'),
    caddyAdminConfig: recovery('The address proxy could not load the requested route. Review the address and proxy service before trying again.', 'domains', 'Review proxy route'),
    caddyPublishedBindings: recovery('The address proxy could not use its public ports. Check for another service on those ports or choose a tunnel.', 'domains', 'Review address ports'),
    caddyListeners: recovery('The address proxy is not listening for app traffic. Check its service configuration before verifying the address.', 'machines', 'Check proxy listeners'),
    caddyRoutedNetworks: recovery('The address proxy cannot reach the app network. Check the app and proxy connections on the serving machine.', 'machines', 'Check app network'),
} as const;

const legacyGenericRemedy = 'Inspect the reported deployment phase and current target state. Restore the missing prerequisite or choose a supported target action, then retry the original request after confirming whether the previous change took effect.';
const fallback = recovery('Happier could not complete this change. Check deployment history and the running app before trying again.', 'history', 'Review deployment');
const transactionRollbackRecovery = recovery('The Home could not record this change and rolled it back. Review the deployment and try again.', 'review', 'Review deployment');
const nativeConflictRecovery = recovery('Happier could not identify one running service generation for this change. Check the services on the serving machine before trying again.', 'machines', 'Check running services');

function recoveryDetails(details: Record<string, unknown>): Record<string, unknown> {
    // Store keeps completed steps alongside the Domain owner's failure. Its
    // retained wrapper recovery must not replace that more specific cause.
    return details.kind === 'partial' && details.phase === 'domains' && isRecord(details.failure)
        ? details.failure : details;
}

function recoveryFor(details: Record<string, unknown>, errorCode?: string) {
    details = recoveryDetails(details);
    // The transport sets this fact only after consuming Home's confirmed rollback.
    if (details.requiredFact === 'transaction_commit') return transactionRollbackRecovery;
    const failure = isRecord(details.failure) ? details.failure : undefined;
    const sourceAdmission = isRecord(details.sourceAdmission) ? details.sourceAdmission
        : isRecord(failure?.sourceAdmission) ? failure.sourceAdmission : undefined;
    // A recorded typed cause (an unconfirmed transition's Home refusal) is more specific than the outcome code it settled as.
    const failureCause = isRecord(details.failureCause) ? details.failureCause
        : isRecord(failure?.failureCause) ? failure.failureCause : undefined;
    const codes = [sourceAdmission?.reason, failure?.reason, failureCause?.errorCode, failure?.code, details.reason, details.code, errorCode];
    const code = codes.find((candidate): candidate is keyof typeof recoveries =>
        typeof candidate === 'string' && Object.hasOwn(recoveries, candidate));
    if (code === 'deployment_conflict' && (details.step === 'native_execution'
        || failure?.step === 'native_execution'
        || failureCause?.phase === 'deployment.domain.native_execution')) return nativeConflictRecovery;
    const fact = failure?.requiredFact ?? details.requiredFact;
    if (code === 'required_fact_unavailable' && typeof fact === 'string' && Object.hasOwn(missingFacts, fact)) {
        return missingFacts[fact as keyof typeof missingFacts];
    }
    return code ? recoveries[code] : fallback;
}

/** Existing storage projection stays closed: navigation belongs only to the read projection below. */
export function projectDeploymentFailureRecoveryV1(details: Record<string, never>, errorCode?: string): z.infer<typeof DeploymentFailureRecoveryV1Schema>;
export function projectDeploymentFailureRecoveryV1<T extends Record<string, unknown>>(details: T, errorCode?: string): T & {
    requiredFact: string; remedy: string;
};
export function projectDeploymentFailureRecoveryV1<T extends Record<string, unknown>>(details: T, errorCode?: string): T & {
    requiredFact: string; remedy: string;
} {
    const facts = recoveryDetails(details);
    const recovery = recoveryFor(facts, errorCode);
    const failure = isRecord(facts.failure) ? facts.failure : undefined;
    const sourceAdmission = isRecord(facts.sourceAdmission) ? facts.sourceAdmission
        : isRecord(failure?.sourceAdmission) ? failure.sourceAdmission : undefined;
    const authoredRemedy = typeof facts.remedy === 'string' && facts.remedy !== legacyGenericRemedy ? facts.remedy
        : typeof failure?.remedy === 'string' ? failure.remedy
            : typeof sourceAdmission?.remedy === 'string' ? sourceAdmission.remedy : undefined;
    return projectActionFailureRecoveryV1({ ...details,
        requiredFact: typeof facts.requiredFact === 'string'
            && !(facts.step === 'native_execution'
                && DeploymentFailureRecoveryV1Schema.shape.requiredFact.safeParse(facts.requiredFact).success) ? facts.requiredFact
            : typeof failure?.requiredFact === 'string' ? failure.requiredFact
                : typeof sourceAdmission?.requiredFact === 'string' ? sourceAdmission.requiredFact
                    : undefined,
        remedy: recovery === nativeConflictRecovery && authoredRemedy === recoveries.deployment_conflict.remedy
            ? undefined : authoredRemedy,
    }, {
        requiredFact: facts.step === 'native_execution' ? 'nativeExecutionResult' : 'deploymentActionResult',
        remedy: recovery.remedy,
    });
}

/** Receipt, review and Store render this result; callers supply their existing navigation context. */
export function readDeploymentFailureRecoveryV1(errorCode: string, details?: unknown): DeploymentFailureRecoveryPresentationV1 {
    const record = isRecord(details) ? details : {};
    const projected = projectDeploymentFailureRecoveryV1(record, errorCode);
    const selected = recoveryFor(record, errorCode);
    const authored = projected.remedy;
    return { requiredFact: projected.requiredFact,
        remedy: authored === 'retry_original_request' ? 'The requester could not be confirmed. Reconnect the original session and submit the request again.'
            : authored === 'run_from_authorized_host' ? 'This source is on a machine you cannot use for this request. Choose an authorized source machine.'
                : authored === legacyGenericRemedy || authored === fallback.remedy ? selected.remedy : authored,
        nextAction: selected.nextAction };
}

/**
 * A refused press's typed recovery: the remedy and the one route to fix it (the Environment's Deploy banner, the
 * platform target sheet). Null when this owner has no recovery for the code, so the caller keeps its own sentence.
 */
export function readDeploymentRefusalRecoveryV1(errorCode: string, details?: unknown): DeploymentFailureRecoveryPresentationV1 | null {
    return recoveryFor(isRecord(details) ? details : {}, errorCode) === fallback ? null : readDeploymentFailureRecoveryV1(errorCode, details);
}
