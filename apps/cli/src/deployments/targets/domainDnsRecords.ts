import type { ActionExecuteFailure } from '@happier-dev/protocol';
import type { HostReviewedChildInvocationV1 } from '@happier-dev/protocol/actions/executor/types';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainV1';
import type { DeploymentDomainDnsInputV1, DeploymentDomainDnsRecordInputV1 } from '@happier-dev/protocol';

type Child = HostReviewedChildInvocationV1;
const missing = (source: 'expected_ingress' | 'provider_observation'): ActionExecuteFailure => ({ ok: false,
    errorCode: 'required_fact_unavailable', error: 'required_fact_unavailable', details: { requiredFact: 'domain_dns_records', source } });

/** Required records belong to the retained Domain's producer, never the DNS adapter or a presenter. */
export function buildDomainDnsRecordChildren(input: DeploymentDomainDnsInputV1, content: DeploymentDomainContentV1):
    { children: Child[] } | ActionExecuteFailure {
    if (content.target.kind !== 'provider') return missing('expected_ingress');
    const observation = content.providerObservation;
    if (!observation || observation.hostname !== content.hostname || observation.state === 'removed' || !observation.dns.length)
        return missing('provider_observation');
    const groups = new Map<string, { name: string; type: string; values: Set<string> }>();
    for (const record of observation.dns) {
        const name = `${record.name.replace(/\.$/u, '').toLowerCase()}.`;
        const key = `${name}:${record.type}`;
        const group = groups.get(key) ?? { name, type: record.type, values: new Set<string>() };
        group.values.add(record.value);
        groups.set(key, group);
    }
    return { children: [...groups.values()].map((record, index) => ({ action: input.dns.action,
        role: `domain-dns:${index}`, input: { credentialRef: input.dns.credentialRef, zoneId: input.dns.zoneId,
            name: record.name, type: record.type, values: [...record.values], ttl: input.dns.ttl } satisfies DeploymentDomainDnsRecordInputV1 })) };
}
