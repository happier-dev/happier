import * as React from 'react';
import type { DeploymentTemplateInstantiateInputV1 } from '@happier-dev/protocol/deployments/deploymentTemplateInstantiationV1';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { Item } from '@/components/ui/lists/Item';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { t } from '@/text';

type TemplateDomain = DeploymentTemplateV1['domains'][number];

export function projectDeploymentTemplateDomainChoices(
  domains: readonly TemplateDomain[],
  hostnames: Readonly<Record<string, string>>,
) {
  const bindings: NonNullable<DeploymentTemplateInstantiateInputV1['domainBindings']> = [];
  let missingRequired = false;
  for (const domain of domains) {
    const hostname = hostnames[domain.key]?.trim();
    if (hostname) bindings.push({ templateDomainId: domain.key, hostname });
    else if (domain.required) missingRequired = true;
  }
  return { bindings, missingRequired };
}

/**
 * One address row per template Domain: the hostname a person types for that service, with its DNS route beneath.
 * Deploy an app, Store preparation, a Project's Add review and a preset's App share these rows.
 * The template preparer owns hostname validation.
 */
export function DeploymentTemplateDomainRows(
  props: Readonly<{
    domains: readonly TemplateDomain[];
    hostname: (domainKey: string) => string;
    onChangeHostname: (domainKey: string, hostname: string) => void;
    testIDPrefix: string;
  }>,
) {
  const serviceCounts = new Map<string, number>();
  for (const domain of props.domains)
    serviceCounts.set(
      domain.service,
      (serviceCounts.get(domain.service) ?? 0) + 1,
    );
  return (
    <>
      {props.domains.map((domain) => {
        const service =
          serviceCounts.get(domain.service)! > 1
            ? `${domain.service}:${domain.containerPort}`
            : domain.service;
        const address =
          props.domains.length === 1
            ? t('capabilities.store.appPage.domainAddress')
            : t('capabilities.store.appPage.domainAddressFor', { service });
        const label = domain.required
          ? address
          : `${address} (${t('common.optional')})`;
        const helper = t('capabilities.store.appPage.domainDnsHint', {
          route: t('capabilities.store.appPage.addressBody', {
            service: domain.service,
            port: domain.containerPort,
          }),
        });
        return (
          <Item
            key={domain.key}
            title={label}
            accessoryLayout="stacked"
            showChevron={false}
            rightElement={
              <FieldItem label={null} supportingText={helper}>
                <FieldTextInput
                  testID={`${props.testIDPrefix}.${domain.key}`}
                  value={props.hostname(domain.key)}
                  onChangeText={(hostname) =>
                    props.onChangeHostname(domain.key, hostname)
                  }
                  accessibilityLabel={label}
                  accessibilityHint={helper}
                  placeholder={t(
                    'capabilities.store.appPage.domainPlaceholder',
                  )}
                  autoCapitalize="none"
                  keyboardType="url"
                />
              </FieldItem>
            }
          />
        );
      })}
    </>
  );
}
