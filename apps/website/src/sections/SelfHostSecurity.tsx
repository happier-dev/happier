import { motion, useReducedMotion } from 'framer-motion';
import { copy } from '@/theme/copy';

export function SelfHostSecurity() {
    const [line1, line2] = copy.selfHost.headline.split('\n');
    return (
        <section
            id="self-host"
            className="relative overflow-hidden px-6 py-32 sm:py-40"
            style={{
                background:
                    'radial-gradient(1200px 500px at 50% 0%, rgba(52,199,89,0.05), transparent 60%)',
            }}
        >
            <div className="mx-auto max-w-[1180px]">
                <div className="grid grid-cols-1 items-start gap-16 lg:grid-cols-2">
                    <motion.div
                        initial={{ opacity: 0, y: 20 }}
                        whileInView={{ opacity: 1, y: 0 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.6 }}
                    >
                        <span className="chip">{copy.selfHost.kicker}</span>
                        <h2 className="mt-5 text-[44px] font-semibold leading-[1.05] tracking-[-0.02em] text-[color:var(--fg-primary)] sm:text-[56px]">
                            <span className="block">{line1}</span>
                            <span className="block bg-gradient-to-b from-[color:var(--fg-primary)] to-[color:var(--fg-primary-soft)] bg-clip-text text-transparent">
                                {line2}
                            </span>
                        </h2>
                        <p className="mt-5 max-w-[480px] text-[16.5px] leading-[1.55] text-[color:var(--fg-secondary)]">
                            {copy.selfHost.body}
                        </p>

                        <ul className="mt-8 space-y-4">
                            {copy.selfHost.bullets.map(b => (
                                <li key={b.title} className="flex items-start gap-3">
                                    <span className="mt-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-accent-green/15 text-accent-green">
                                        ✓
                                    </span>
                                    <div>
                                        <div className="text-[14px] font-semibold text-[color:var(--fg-primary)]">
                                            {b.title}
                                        </div>
                                        <div className="text-[13px] text-[color:var(--fg-secondary)]">
                                            {b.body}
                                        </div>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    </motion.div>

                    {/* Encryption diagram */}
                    <motion.div
                        initial={{ opacity: 0, scale: 0.96 }}
                        whileInView={{ opacity: 1, scale: 1 }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.7, ease: [0.2, 0, 0, 1] }}
                        className="relative"
                    >
                        <EncryptionDiagram />
                    </motion.div>
                </div>
            </div>
        </section>
    );
}

type SecurityFlowAnimation = {
    durationSeconds: number;
    repeatCount: 'indefinite';
};

export function resolveSecurityFlowAnimation(
    prefersReducedMotion: boolean,
): SecurityFlowAnimation | null {
    if (prefersReducedMotion) return null;
    return {
        durationSeconds: 3,
        repeatCount: 'indefinite',
    };
}

function EncryptionDiagram() {
    const prefersReducedMotion = useReducedMotion() === true;
    const flowAnimation = resolveSecurityFlowAnimation(prefersReducedMotion);

    return (
        <div className="relative mx-auto aspect-[4/3] w-full max-w-[520px] rounded-token-modal border border-[color:var(--border-subtle)] bg-[color:var(--surface-card)] p-8 shadow-device-active">
            <div className="relative grid h-full grid-cols-3 items-center gap-6">
                <Node label="Your laptop" sub="client encrypts" icon="💻" />
                <div className="flex flex-col items-center">
                    <RelayNode />
                    <div className="mt-3 text-center text-[11px] font-medium uppercase tracking-[0.14em] text-[color:var(--fg-tertiary)]">
                        relay
                    </div>
                    <div className="mt-1 text-center text-[10.5px] text-[color:var(--fg-secondary)]">
                        cannot read your data
                    </div>
                </div>
                <Node label="Your phone" sub="client decrypts" icon="📱" />

                {/* Dashed animated paths */}
                <svg
                    className="pointer-events-none absolute inset-0 h-full w-full"
                    viewBox="0 0 100 100"
                    preserveAspectRatio="none"
                >
                    <defs>
                        <linearGradient id="flowGrad" x1="0" y1="0" x2="1" y2="0">
                            <stop offset="0%" stopColor="#34C759" stopOpacity="0" />
                            <stop offset="50%" stopColor="#34C759" stopOpacity="0.7" />
                            <stop offset="100%" stopColor="#34C759" stopOpacity="0" />
                        </linearGradient>
                    </defs>
                    <line
                        x1="22"
                        y1="50"
                        x2="50"
                        y2="50"
                        stroke="var(--border-strong)"
                        strokeWidth="0.5"
                        strokeDasharray="2 2"
                    />
                    <line
                        x1="50"
                        y1="50"
                        x2="78"
                        y2="50"
                        stroke="var(--border-strong)"
                        strokeWidth="0.5"
                        strokeDasharray="2 2"
                    />
                    <rect
                        x="20"
                        y="49"
                        width="60"
                        height="2"
                        fill="url(#flowGrad)"
                        opacity="0.9"
                    >
                        {flowAnimation ? (
                            <animateTransform
                                attributeName="transform"
                                type="translate"
                                from="-50 0"
                                to="50 0"
                                dur={`${flowAnimation.durationSeconds}s`}
                                repeatCount={flowAnimation.repeatCount}
                            />
                        ) : null}
                    </rect>
                </svg>
            </div>
        </div>
    );
}

function Node({ label, sub, icon }: { label: string; sub: string; icon: string }) {
    return (
        <div className="flex flex-col items-center text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-token-xl bg-[color:var(--surface-subtle)] text-2xl">
                {icon}
            </div>
            <div className="mt-3 text-[12.5px] font-semibold text-[color:var(--fg-primary)]">{label}</div>
            <div className="mt-0.5 text-[10.5px] text-[color:var(--fg-secondary)]">{sub}</div>
        </div>
    );
}

function RelayNode() {
    return (
        <div className="relative flex h-16 w-16 items-center justify-center rounded-token-xl border border-[color:var(--border-strong)] bg-[color:var(--surface-card-secondary)] text-[color:var(--fg-secondary)]">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                    d="M8 10V8a4 4 0 1 1 8 0v2M6 10h12v10H6z"
                    stroke="currentColor"
                    strokeOpacity="0.6"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                />
            </svg>
            <span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[color:var(--surface-card)] bg-accent-green" />
        </div>
    );
}
