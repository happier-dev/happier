import {
  DeploymentTargetDomainResultV1ProtocolSchema, DeploymentTargetGeneratedDomainAddInputV1ProtocolSchema, DeploymentTargetRoleInputProtocolSchemasV1, isRecord,
  settleDeploymentTargetDomainRemovalV1, type DeploymentTargetDomainAddInputV1, type DeploymentTargetDomainResultV1,
  type JsonValue,
} from '@happier-dev/plugin-sdk';
import type { PluginAccountActionContext, PluginActionDeclaration, PluginActionDefinition } from '@happier-dev/plugin-sdk/actions';
import { PluginError, withActionFailureDiagnostic } from '@happier-dev/plugin-sdk/errors';
import { defineProtocolArray, defineProtocolLiteral, defineProtocolObject, defineProtocolString, defineProtocolUnion } from '@happier-dev/plugin-sdk/protocol';

import { projectRailwayFailure, railwayAccountAction, railwayGraphql } from './account.js';
import { railwayRoleInput, readRailwayCoordinates } from './coordinates.js';

type Operation = 'add' | 'read' | 'verify' | 'remove';
type DomainAction = PluginActionDefinition<Extract<PluginActionDeclaration, { execution: { target: 'account' } }>>;
const phase = 'deployment.railway.domain';

const open = { policy: 'additive-open/drop' } as const;
const text = defineProtocolString({ minLength: 1 });
const nativeString = defineProtocolString();
const nullableString = defineProtocolUnion([nativeString, defineProtocolLiteral(null)]);
const domainIdentity = defineProtocolObject({
  id: text, domain: text, projectId: nullableString, environmentId: text, serviceId: text,
}, open);
const domainStatus = defineProtocolObject({
  verified: defineProtocolUnion([defineProtocolLiteral(true), defineProtocolLiteral(false)]),
  certificateStatus: text, verificationDnsHost: nullableString, verificationToken: nullableString,
  dnsRecords: defineProtocolArray(defineProtocolObject({
    fqdn: nativeString, recordType: text, requiredValue: nativeString, status: text,
  }, open)),
}, open);

// The public schema exposes distinct ownership, DNS propagation and certificate facts.
// https://docs.railway.com/integrations/api/manage-domains
const identityFields = 'id domain projectId environmentId serviceId';
const statusFields = 'status { verified certificateStatus verificationDnsHost verificationToken dnsRecords { fqdn recordType requiredValue status } }';

function invalidResponse(): never {
  throw new PluginError({ code: 'provider_response_invalid', details: { phase } });
}

function observe(hostname: string, domain: Record<string, unknown>): DeploymentTargetDomainResultV1 {
  const status = domainStatus.safeParse(domain.status);
  if (!status.success) return invalidResponse();
  const { certificateStatus, dnsRecords, verificationDnsHost, verificationToken, verified } = status.data;
  const dns: DeploymentTargetDomainResultV1['dns'] = [];
  const needsDns = dnsRecords.filter(record => record.status !== 'DNS_RECORD_STATUS_PROPAGATED');
  for (const record of needsDns) {
    const type = record.recordType.replace(/^DNS_RECORD_TYPE_/u, '');
    if (['A', 'CNAME', 'NS', 'TXT'].includes(type) && record.fqdn && record.requiredValue) {
      dns.push({ type, name: record.fqdn, value: record.requiredValue });
    }
  }
  if (!verified && verificationDnsHost && verificationToken) {
    // Railway CLI accepts both raw and already prefixed tokens and publishes exactly one prefix.
    const value = 'railway-verify=' + verificationToken.replace(/^(?:railway-verify=)+/u, '');
    if (!dns.some(record => record.type === 'TXT' && record.name === verificationDnsHost && record.value === value)) {
      dns.push({ type: 'TXT', name: verificationDnsHost, value });
    }
  }
  const state = certificateStatus === 'CERTIFICATE_STATUS_TYPE_ISSUE_FAILED' ? 'failed'
    : verified && needsDns.length === 0 && certificateStatus === 'CERTIFICATE_STATUS_TYPE_VALID' ? 'active' : 'pending';
  return { v: 1, hostname, state, dns };
}

async function run(input: DeploymentTargetDomainAddInputV1, context: PluginAccountActionContext, operation: Operation): Promise<DeploymentTargetDomainResultV1> {
  const coordinates = readRailwayCoordinates(input);
  const hostname = input.domain.hostname;
  const recoveringAssignment = operation === 'verify' && 'providerAssigned' in input.domain && input.domain.providerAssigned === true;
  const graphql = railwayGraphql(context);

  async function request(document: string, variables: Readonly<Record<string, unknown>>, effectAttempted = false) {
    try {
      return await graphql(document, variables);
    } catch (error) {
      return projectRailwayFailure(error, context, `${phase}.${operation}`, effectAttempted);
    }
  }

  function select(row: unknown, expectedHostname: string | null) {
    if (!isRecord(row)) return invalidResponse();
    const identity = domainIdentity.safeParse(row);
    if (!identity.success) return invalidResponse();
    const { id, domain, projectId, environmentId, serviceId } = identity.data;
    if ((expectedHostname !== null && domain !== expectedHostname) || (projectId !== null && projectId !== coordinates.projectId)
      || environmentId !== coordinates.environmentId || serviceId !== coordinates.serviceId) {
      throw new PluginError({ code: 'target_mismatch', details: { phase } });
    }
    return { id, hostname: domain, row };
  }

  function observeAssigned(host: string, row: Record<string, unknown>): DeploymentTargetDomainResultV1 {
    switch (row.syncStatus) {
      case 'ACTIVE': return { v: 1, hostname: host, state: 'active', dns: [] };
      case 'CREATING': case 'UPDATING': return { v: 1, hostname: host, state: 'pending', dns: [] };
      case 'DELETING': return { v: 1, hostname: host, state: 'pending', dns: [] };
      case 'DELETED': return { v: 1, hostname: host, state: 'removed', dns: [] };
      default: return invalidResponse();
    }
  }

  async function readCurrent() {
    const { domains } = await request(`query($projectId: String!, $environmentId: String!, $serviceId: String!) {
      domains(projectId: $projectId, environmentId: $environmentId, serviceId: $serviceId) {
        customDomains { ${identityFields} ${operation === 'remove' ? '' : statusFields} }
        serviceDomains { ${identityFields} syncStatus }
      }
    }`, coordinates);
    if (!isRecord(domains) || !Array.isArray(domains.customDomains)) return invalidResponse();
    if (!Array.isArray(domains.serviceDomains)) return invalidResponse();
    for (const [rows, generated] of [[domains.customDomains, false], [domains.serviceDomains, true]] as const) {
      if (recoveringAssignment && !generated) continue;
      for (const row of rows as readonly unknown[]) {
        if (!isRecord(row) || typeof row.domain !== 'string' || !row.domain) return invalidResponse();
        if (row.domain === hostname) return { ...select(row, hostname), generated };
      }
    }
    return null;
  }

  if (operation === 'add') {
    if (hostname === null) {
      const { serviceDomainCreate } = await request(`mutation($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) { ${identityFields} syncStatus }
      }`, { input: { serviceId: coordinates.serviceId, environmentId: coordinates.environmentId } }, true);
      const assigned = select(serviceDomainCreate, null);
      return observeAssigned(assigned.hostname, assigned.row);
    }
    const { customDomainCreate } = await request(`mutation($input: CustomDomainCreateInput!) {
      customDomainCreate(input: $input) { ${identityFields} ${statusFields} }
    }`, { input: { ...coordinates, domain: hostname } }, true);
    return observe(hostname, select(customDomainCreate, hostname).row);
  }

  if (hostname === null) return invalidResponse();
  const current = await readCurrent();
  if (operation === 'remove') {
    if (current) {
      await settleDeploymentTargetDomainRemovalV1({
        remove: async () => {
          const field = current.generated ? 'serviceDomainDelete' : 'customDomainDelete';
          const result = await request(`mutation($id: String!) { ${field}(id: $id) }`, { id: current.id }, true);
          if (typeof result[field] !== 'boolean') return invalidResponse();
        },
        observeAbsent: async () => await readCurrent() === null,
      });
    }
    return { v: 1, hostname, state: 'removed', dns: [] };
  }

  if (!current) {
    throw withActionFailureDiagnostic(new PluginError({ code: 'deployment_unavailable' }), { phase, causeKind: 'not_found' });
  }
  return current.generated ? observeAssigned(hostname, current.row) : observe(hostname, current.row);
}

function domainAction(operation: Operation, title: string, confirmation?: string) {
  const roleInput = operation === 'add' ? DeploymentTargetGeneratedDomainAddInputV1ProtocolSchema
    : DeploymentTargetRoleInputProtocolSchemasV1[`domains.${operation}`];
  const write = operation === 'add' || operation === 'remove';
  return {
    ...railwayAccountAction,
    title, dangerLevel: write ? 'writesRemote' : 'safe', readOnly: !write,
    ...(confirmation ? { confirmation: { title: confirmation } } : {}),
    inputSchema: railwayRoleInput(roleInput.jsonSchema),
    resultSchema: DeploymentTargetDomainResultV1ProtocolSchema.jsonSchema,
    run: (input: JsonValue, context: PluginAccountActionContext) => run(input as unknown as DeploymentTargetDomainAddInputV1, context, operation),
  } satisfies DomainAction;
}

export const domainActions = {
  'domains-add': domainAction('add', 'Add the reviewed Railway Domain', 'Add this Domain to Railway?'),
  'domains-read': domainAction('read', 'Read the selected Railway Domain'),
  'domains-verify': domainAction('verify', 'Verify the selected Railway Domain'),
  'domains-remove': domainAction('remove', 'Remove the selected Railway Domain', 'Remove this Domain from Railway?'),
} as const satisfies Readonly<Record<`domains-${Operation}`, DomainAction>>;
