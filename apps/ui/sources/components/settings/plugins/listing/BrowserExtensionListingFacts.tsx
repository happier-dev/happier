import * as React from 'react';
import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { t } from '@/text';

export type BrowserExtensionListingFactsProps = Readonly<{
    browserExtension: Readonly<{ version?: string; permissions?: readonly string[]; hostPermissions?: readonly string[] }>;
    publisher?: string;
    sourceTitle?: string;
    testID?: string;
}>;

/** Published manifest facts and the browser service's acquired review share the same labelled rows. */
export function BrowserExtensionListingFacts(props: BrowserExtensionListingFactsProps) {
    const facts = props.browserExtension;
    const permissions = [...new Set([...(facts.permissions ?? []), ...(facts.hostPermissions ?? [])])];
    const labels = {
        storage: t('capabilities.store.browserExtensionInstall.storage'),
        tabs: t('capabilities.store.browserExtensionInstall.tabs'),
        scripting: t('capabilities.store.browserExtensionInstall.scripting'),
        alarms: t('capabilities.store.browserExtensionInstall.alarms'),
        fontSettings: t('capabilities.store.browserExtensionInstall.fontSettings'),
    };
    let allSitesShown = false;
    return <>
        {facts.version || props.publisher || props.sourceTitle ? <ItemGroup title={t('common.details')}>
            {props.publisher ? <Item testID={`${props.testID}.publisher`}
                title={t('settingsPlugins.catalog.byPublisher', { publisher: props.publisher })} mode="info" showChevron={false} /> : null}
            {facts.version ? <Item testID={`${props.testID}.version`} title={t('common.version')}
                detail={facts.version} mode="info" showChevron={false} /> : null}
            {props.sourceTitle ? <Item testID={`${props.testID}.source`} title={t('settingsPlugins.surfaces.listingSource')}
                detail={props.sourceTitle} mode="info" showChevron={false} /> : null}
        </ItemGroup> : null}
        {permissions.length ? <ItemGroup title={t('capabilities.store.browserExtensionInstall.permissions')}>
            {permissions.map(permission => {
                const allSites = permission === '<all_urls>' || permission === '*://*/*';
                if (allSites && allSitesShown) return null;
                if (allSites) allSitesShown = true;
                const site = permission.includes('://');
                const title = allSites ? t('capabilities.store.browserExtensionInstall.allSites')
                    : site ? t('capabilities.store.browserExtensionInstall.siteAccess')
                    : Object.hasOwn(labels, permission) ? labels[permission as keyof typeof labels] : permission;
                return <Item key={permission} testID={`${props.testID}.permission.${permission}`} title={title}
                    {...(site && !allSites ? { subtitle: permission } : {})} mode="info" showChevron={false} />;
            })}
        </ItemGroup> : null}
    </>;
}
