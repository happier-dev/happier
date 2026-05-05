import type { ReactNode } from 'react';
import { motion } from 'framer-motion';
import { cn } from '@/utils/cn';

type Props = {
    id: string;
    kicker: string;
    headline: string;
    body: string;
    visual: ReactNode;
    /** 2-column (default) or stacked text-above-visual. */
    layout?: 'split' | 'stacked';
    /** 2-column only: swap visual/text order on lg. */
    reverse?: boolean;
};

export function Pillar({
    id,
    kicker,
    headline,
    body,
    visual,
    layout = 'split',
    reverse = false,
}: Props) {
    const [line1, line2] = headline.split('\n');

    const textBlock = (
        <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
        >
            <span className="chip">{kicker}</span>
            <h2 className="mt-5 text-[40px] font-semibold leading-[1.05] tracking-[-0.02em] text-[color:var(--fg-primary)] sm:text-[56px]">
                <span className="block">{line1}</span>
                {line2 && (
                    <span className="block bg-gradient-to-b from-[color:var(--fg-primary)] to-[color:var(--fg-primary-soft)] bg-clip-text text-transparent">
                        {line2}
                    </span>
                )}
            </h2>
            <p className={cn(
                'mt-5 text-[16.5px] leading-[1.55] text-[color:var(--fg-secondary)]',
                layout === 'stacked' ? 'max-w-[720px]' : 'max-w-[520px]',
            )}>
                {body}
            </p>
        </motion.div>
    );

    const visualBlock = (
        <motion.div
            initial={{ opacity: 0, y: 30 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-80px' }}
            transition={{ duration: 0.7, ease: [0.2, 0, 0, 1], delay: 0.1 }}
            className={layout === 'stacked' ? 'mt-14' : ''}
        >
            {visual}
        </motion.div>
    );

    if (layout === 'stacked') {
        return (
            <section id={id} className="relative scroll-mt-20 px-6 py-28 sm:py-36">
                <div className="mx-auto max-w-[1180px]">
                    {textBlock}
                    {visualBlock}
                </div>
            </section>
        );
    }

    return (
        <section id={id} className="relative scroll-mt-20 px-6 py-28 sm:py-36">
            <div className="mx-auto max-w-[1180px]">
                <div
                    className={cn(
                        'grid grid-cols-1 items-center gap-16 lg:grid-cols-2',
                        reverse && 'lg:[&>*:first-child]:order-2',
                    )}
                >
                    {textBlock}
                    {visualBlock}
                </div>
            </div>
        </section>
    );
}
