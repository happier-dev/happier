import type { ReactNode } from 'react';

/**
 * The three-node diagram — device, relay, machine — drawn once.
 *
 * WHY THIS EXISTS. The homepage self-host section and the security page both
 * draw the same three nodes on the same rails, and both had their own copy of
 * the markup. They agreed on the row (`.stackrow`) and disagreed on everything
 * that moved: the homepage animated amber dots along the links and the security
 * page animated a chip carrying the message, each missing the other's motion.
 * Two pictures of the same three boxes, differing in ways no one chose.
 *
 * Both behaviours now live here and are switched on per call site, so the two
 * pages can differ deliberately rather than by drift.
 *
 * The rails are siblings of the cells rather than gutter items on purpose: they
 * anchor to the icon centres (1/6, 3/6, 5/6 of the row) at every width, which
 * is what keeps them landing on the glyphs instead of on whatever space the
 * grid had left over.
 */

export type JourneyNode = {
    id: string;
    label: string;
    /** Second line under the label. Infrastructure on the homepage, the verb on security. */
    detail: string;
};

export type NodeJourneyProps = {
    nodes: ReadonlyArray<JourneyNode>;
    /** Renders the glyph for a node id. Each page owns its own icon set. */
    renderIcon: (id: string) => ReactNode;
    /**
     * The chip that travels the wire. Omit it and the lane is not rendered at
     * all — no reserved height, no empty box.
     */
    packet?: { plain: string; cipher: string };
    className?: string;
};

export function NodeJourney({ nodes, renderIcon, packet, className }: NodeJourneyProps) {
    return (
        <div className={className}>
            {packet ? (
                <div className="wire__lane" aria-hidden>
                    <div className="wire__carrier">
                        <div className="wire__packet">
                            <span className="wire__text wire__text--plain">{packet.plain}</span>
                            <span className="wire__text wire__text--cipher font-mono">
                                {packet.cipher}
                            </span>
                        </div>
                    </div>
                </div>
            ) : null}

            <div className="stackrow">
                {nodes.map((node) => (
                    <div key={node.id} className="text-center">
                        <span className="stackrow__icon" style={{ color: 'var(--fg)' }}>
                            {renderIcon(node.id)}
                        </span>
                        {/* 15px wraps "Your machine" at phone column widths while the
                            other two labels hold one line, which staggers the subtitles. */}
                        <span
                            className="mt-3.5 block text-[13px] font-semibold leading-tight sm:text-[15px]"
                            style={{ color: 'var(--fg)' }}
                        >
                            {node.label}
                        </span>
                        <span
                            className="stackrow__detail mt-1 block text-[12.5px] leading-[1.45]"
                            style={{ color: 'var(--muted)' }}
                        >
                            {node.detail}
                        </span>
                    </div>
                ))}

                <FlowRail className="stackflow--1" />
                <FlowRail className="stackflow--2" />
            </div>
        </div>
    );
}

/** Two dots out, one back — enough to read as traffic without becoming a barber pole. */
function FlowRail({ className }: { className: string }) {
    return (
        <div className={`stackflow ${className}`} aria-hidden>
            <span className="stackflow__dot" />
            <span className="stackflow__dot" style={{ animationDelay: '1.3s' }} />
            <span className="stackflow__dot stackflow__dot--back" style={{ animationDelay: '0.65s' }} />
        </div>
    );
}
