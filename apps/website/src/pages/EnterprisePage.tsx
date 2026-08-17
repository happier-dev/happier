import { InstallCommand } from '../components/InstallCommand';
import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import { ENTERPRISE_DEPLOY_URL, ENTERPRISE_DOCS_URL } from '../data/enterprise';
import { useSiteData } from '../i18n/siteData';
import { rich } from '../i18n/rich';
import type { ReactNode } from 'react';
import { useLocalePath } from '../i18n';

/**
 * /enterprise
 *
 * NOT a feature page. A feature page answers "can it do X"; this one answers
 * "can I put it in front of a security review", which is a different reader
 * with a different tolerance for a claim that turns out to be aspirational.
 *
 * Two editorial rules were applied throughout and are worth keeping:
 *   1. Every capability below exists in the shipped server AND in the shipped
 *      docs. Three things the repository README advertises are deliberately
 *      absent; src/data/enterprise.ts records which and why.
 *   2. The Anthropic paragraph states what Anthropic's own documentation says
 *      and stops there. A reader who is blocked by a compliance policy does not
 *      need to be told that this is funny.
 */
function CapabilityList({ items, dataSection, heading, standfirst }: {
    items: ReadonlyArray<{ id: string; title: string; body: string }>;
    dataSection: string;
    heading: string;
    standfirst: string;
}) {
    return (
        <section className="relative" data-section={dataSection}>
            <div className="mx-auto max-w-[1400px] px-6 py-10 md:px-10 md:py-14">
                <div className="max-w-[880px]">
                    <h2 className="font-display text-[26px] font-normal leading-[1.14] tracking-[-0.025em] md:text-[34px]">
                        {heading}
                    </h2>
                    <p className="mt-4 max-w-[720px] text-[16px] leading-[1.65]" style={{ color: 'var(--muted)' }}>
                        {standfirst}
                    </p>
                    <dl className="mt-8 space-y-7">
                        {items.map((item) => (
                            <div key={item.id}>
                                <dt className="text-[17px] font-semibold" style={{ color: 'var(--fg)' }}>
                                    {item.title}
                                </dt>
                                <dd className="mt-2 max-w-[760px] text-[16px] leading-[1.66]" style={{ color: 'var(--muted)' }}>
                                    {item.body}
                                </dd>
                            </div>
                        ))}
                    </dl>
                </div>
            </div>
        </section>
    );
}

export function EnterprisePage() {
    const { pageProse: { PAGE_PROSE } } = useSiteData();
    const localeHref = useLocalePath();

    const { enterprise: { ENTERPRISE_ACCESS, ENTERPRISE_DATA, ENTERPRISE_ZDR } } = useSiteData();

    return (
        <PageShell>
            {/*
              * "Run the whole thing on your own infrastructure" was the old H1,
              * and "the whole thing" is the problem: it asks the reader to
              * already know what Happier is before the heading means anything,
              * and it reads like a hobbyist self-hosting a media server. The
              * buyer this page is written for arrives with a compliance team
              * and types the nouns they have to satisfy — self-hosted, SSO,
              * mTLS, where the data lives. All four are controls this server
              * actually ships (apps/server/sources/app/auth/providers/{github,
              * oidc,mtls}, and prisma/schema.prisma's postgresql provider), so
              * the heading names them rather than gesturing at "the whole
              * thing".
              */}
            <PageHeader
                eyebrow={PAGE_PROSE.enterprisePage.p7}
                title={PAGE_PROSE.enterprisePage.p8}
                standfirst={PAGE_PROSE.enterprisePage.p9}
            />

            <Prose data-section="enterprise-shape">
                <P>{rich(PAGE_PROSE.enterprisePage.p0)}</P>
                <P>{rich(PAGE_PROSE.enterprisePage.p1)}</P>
                <P>{rich(PAGE_PROSE.enterprisePage.p2, { 1: (c: ReactNode) => <a
                        href={localeHref('/security')}
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >{c}</a> })}</P>
            </Prose>

            <CapabilityList
                dataSection="enterprise-access"
                heading={PAGE_PROSE.enterprisePage.p10}
                standfirst={PAGE_PROSE.enterprisePage.p11}
                items={ENTERPRISE_ACCESS}
            />

            <CapabilityList
                dataSection="enterprise-data"
                heading={PAGE_PROSE.enterprisePage.p12}
                standfirst={PAGE_PROSE.enterprisePage.p13}
                items={ENTERPRISE_DATA}
            />

            <Prose heading={PAGE_PROSE.enterprisePage.p14} data-section="enterprise-zdr">
                {ENTERPRISE_ZDR.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading={PAGE_PROSE.enterprisePage.p15} data-section="enterprise-licence">
                <P>{rich(PAGE_PROSE.enterprisePage.p3)}</P>
                <P>{rich(PAGE_PROSE.enterprisePage.p4)}</P>
            </Prose>

            <Prose heading={PAGE_PROSE.enterprisePage.p16} data-section="enterprise-cta">
                <P>{rich(PAGE_PROSE.enterprisePage.p5, { 1: (c: ReactNode) => <code className="font-mono">{c}</code> })}</P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
                <P>{rich(PAGE_PROSE.enterprisePage.p6, { 1: (c: ReactNode) => <a href={ENTERPRISE_DEPLOY_URL} className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>{c}</a>, 2: (c: ReactNode) => <a href={ENTERPRISE_DOCS_URL} className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>{c}</a> })}</P>
            </Prose>
        </PageShell>
    );
}
