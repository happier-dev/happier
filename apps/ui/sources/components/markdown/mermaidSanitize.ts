const XLINK_NAMESPACE = 'http://www.w3.org/1999/xlink';

export function removeMermaidNavigation(root: ParentNode): void {
    for (const anchor of Array.from(root.querySelectorAll('a'))) {
        anchor.replaceWith(...Array.from(anchor.childNodes));
    }

    for (const element of Array.from(root.querySelectorAll('*'))) {
        element.removeAttribute('href');
        element.removeAttribute('xlink:href');
        element.removeAttributeNS(XLINK_NAMESPACE, 'href');
        element.removeAttribute('target');
    }
}

export function sanitizeRenderedMermaidSvg(svg: string): string {
    const template = document.createElement('template');
    template.innerHTML = String(svg ?? '');

    for (const script of Array.from(template.content.querySelectorAll('script'))) {
        script.remove();
    }
    for (const element of Array.from(template.content.querySelectorAll('*'))) {
        for (const attribute of Array.from(element.attributes)) {
            if (attribute.name.toLowerCase().startsWith('on')) {
                element.removeAttribute(attribute.name);
            }
        }
    }
    removeMermaidNavigation(template.content);
    return template.innerHTML;
}
