import * as React from 'react';
import type { DeploymentTemplateV1 } from '@happier-dev/protocol/registries';
import { Item } from '@/components/ui/lists/Item';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { FieldTextInput } from '@/components/ui/forms/FieldTextInput';
import { t } from '@/text';

type TemplateDomain = DeploymentTemplateV1['domains'][number];

/**
 * One address row per template Domain: the hostname a person types for that service, with its DNS route beneath.
 * Every surface that chooses a template's addresses (Store preparation, a Project's Add review, a preset's App)
 * renders these rows; the template preparer owns hostname validation.
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
