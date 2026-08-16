import type { EnrichedMarkdownTextProps } from 'react-native-enriched-markdown';

const DEFAULT_ENRICHED_MARKDOWN_MD4C_FLAGS: NonNullable<EnrichedMarkdownTextProps['md4cFlags']> = {
    latexMath: true,
    texMathBackslashDelimiters: false,
};

const AGENT_TEX_ENRICHED_MARKDOWN_MD4C_FLAGS: NonNullable<EnrichedMarkdownTextProps['md4cFlags']> = {
    latexMath: true,
    texMathBackslashDelimiters: true,
};

export function resolveEnrichedMarkdownMd4cFlags(agentTexMath: boolean): NonNullable<EnrichedMarkdownTextProps['md4cFlags']> {
    return agentTexMath
        ? AGENT_TEX_ENRICHED_MARKDOWN_MD4C_FLAGS
        : DEFAULT_ENRICHED_MARKDOWN_MD4C_FLAGS;
}
