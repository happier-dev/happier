export function sanitizeRenderedMermaidSvg(svg: string): string {
    return String(svg ?? '')
        .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
        .replace(/\son[a-zA-Z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g, '')
        .replace(/\s(xlink:href|href)\s*=\s*("javascript:[^"]*"|'javascript:[^']*')/gi, ' $1="#"');
}
