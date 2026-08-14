import { InstallCommand } from '../components/InstallCommand';
import { P, PageHeader, PageShell, Prose } from '../components/PageShell';
import {
    ENTERPRISE_ACCESS,
    ENTERPRISE_DATA,
    ENTERPRISE_DEPLOY_URL,
    ENTERPRISE_DOCS_URL,
    ENTERPRISE_ZDR,
} from '../data/enterprise';

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
                eyebrow="Self-hosted relay"
                title="Self-host the Happier relay: SSO, mTLS and your own database"
                standfirst="Happier is MIT-licensed, and the relay every device talks through is a container you can run yourself. This page is the list of controls that come with it — what the server enforces, what it stores, and what it hands your clients at runtime."
            />

            <Prose data-section="enterprise-shape">
                <P>
                    The shape is worth getting straight before the list. Sessions run on your
                    developers’ own computers, against the provider CLIs they already have. The
                    relay carries messages between those computers and their phones, browsers and
                    desktops. It is the only piece that has to be reachable from outside, and it is
                    the piece you are being asked to host.
                </P>
                <P>
                    Everything below is server configuration: environment variables on that
                    container, enforced by that container, with no Happier-operated service in the
                    path. The default posture of a fresh server is end-to-end encrypted storage and
                    open signup, on the assumption that most people put it behind Tailscale. If you
                    are reading this page you almost certainly want the opposite of the second half
                    of that sentence.
                </P>
                <P>
                    What that encrypted default means underneath — which key is generated where,
                    what your relay is left holding, and the columns it can read without one — is{' '}
                    <a
                        href="/security"
                        className="underline underline-offset-2"
                        style={{ color: 'var(--fg)' }}
                    >
                        the encryption architecture
                    </a>
                    , written for the developer rather than for you. It is the page to send anyone
                    who asks what the server can see; this one stays on what you can enforce.
                </P>
            </Prose>

            <CapabilityList
                dataSection="enterprise-access"
                heading="SSO: GitHub orgs, OIDC groups and client certificates"
                standfirst="Identity is delegated to whatever you already run. Happier’s job is to enforce it on every request rather than only at signup, and to keep asking."
                items={ENTERPRISE_ACCESS}
            />

            <CapabilityList
                dataSection="enterprise-data"
                heading="Storage policy, retention and the database you host"
                standfirst="The controls an auditor asks about second, once they have finished with authentication."
                items={ENTERPRISE_DATA}
            />

            <Prose heading="If your organisation has zero data retention" data-section="enterprise-zdr">
                {ENTERPRISE_ZDR.map((paragraph) => (
                    <P key={paragraph.slice(0, 32)}>{paragraph}</P>
                ))}
            </Prose>

            <Prose heading="What procurement gets: an MIT licence and a container image" data-section="enterprise-licence">
                <P>
                    MIT. Not source-available, not open-core with the auth stack behind a commercial
                    tier, not AGPL. Everything on this page is in the same repository as the client,
                    under the same licence, and none of it is gated on a contract with us. If your
                    organisation’s policy is that copyleft does not come inside the building, that
                    policy does not stop here.
                </P>
                <P>
                    None of the controls above sits behind a purchase: there is no enterprise tier
                    to buy and no seat count to negotiate for any of them. Depending on your
                    procurement process that is either the reassuring part of this page or the
                    concerning one. What you get instead is the source, an MIT licence and a
                    container image.
                </P>
            </Prose>

            <Prose heading="Stand up a test relay and check what it enforces" data-section="enterprise-cta">
                <P>
                    The honest order is: stand the relay up on a throwaway host, point one developer
                    at it, and read <code className="font-mono">GET /v1/features</code> to see
                    exactly what that server is advertising to its clients. That response is the
                    contract, and it is the fastest way to confirm a policy you set is a policy the
                    clients will actually honour.
                </P>
                <div data-cta-location="call-to-action">
                    <InstallCommand />
                </div>
                <P>
                    The{' '}
                    <a href={ENTERPRISE_DEPLOY_URL} className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>
                        Docker deployment guide
                    </a>{' '}
                    covers the image, the volume and the Postgres override. The{' '}
                    <a href={ENTERPRISE_DOCS_URL} className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>
                        server auth reference
                    </a>{' '}
                    covers every variable named above, including the recipes for a public server
                    that requires GitHub or an OIDC provider.
                </P>
            </Prose>
        </PageShell>
    );
}
