declare module 'css-tree/lib/parser' {
    const parse: (source: string, options?: Readonly<{ positions?: boolean }>) => unknown;
    export default parse;
}
