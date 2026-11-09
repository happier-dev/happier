import type { IconName } from '@/components/ui/icons/Icon';

const COCKPIT_TAB_SYMBOLS: Readonly<Partial<Record<IconName, string>>> = {
    'chats-circle': 'bubble.left',
    folder: 'folder',
    'git-branch': 'arrow.triangle.branch',
    list: 'list.bullet',
    'list-bullets': 'list.bullet',
    files: 'square.on.square',
    terminal: 'terminal',
    'stack-simple': 'square.stack',
    stack: 'square.3.layers.3d',
    info: 'info.circle',
    users: 'person.2',
    robot: 'cpu',
    cpu: 'cpu',
    desktop: 'desktopcomputer',
    shield: 'shield',
    'sliders-horizontal': 'slider.horizontal.3',
    'warning-circle': 'exclamationmark.circle',
    'squares-four': 'square.grid.2x2',
    'tree-structure': 'point.3.connected.trianglepath.dotted',
    globe: 'globe',
    'hard-drives': 'server.rack',
    code: 'chevron.left.forwardslash.chevron.right',
    play: 'play',
    'book-bookmark': 'book.closed',
    gear: 'gearshape',
};

/** Native presentation of the same semantic icon declared by a cockpit catalog. */
export function sfSymbolForCockpitTabIcon(icon: IconName): string {
    // Plugin catalogs may contribute any app icon; an unmapped concept retains its plugin identity.
    return COCKPIT_TAB_SYMBOLS[icon] ?? 'puzzlepiece';
}
