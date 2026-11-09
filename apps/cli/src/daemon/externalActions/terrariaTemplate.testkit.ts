// Apache-2.0 Coolify templates/compose/terraria-server.yaml at the exact
// APP-JOURNEY-B/r48 pin. Keep the upstream bytes: the real registry hashes them.
export const terrariaCommit = '972ab7f6f45b5cc6c2efdff207738a4e23d23756';
export const terrariaDocument = '# documentation: https://github.com/hexlo/terraria-server-docker\n'
  + '# slogan: Docker multi-arch Image for Terraria Server.\n# category: games\n# tags: terraria\n# logo: svgs/terraria.svg\n# port: 7777\n\n'
  + 'services:\n  terraria-server:\n    image: hexlo/terraria-server-docker:1.4.5.0\n    stdin_open: true\n    tty: true\n    ports:\n      - 7777:7777\n    volumes:\n      - terraria-server:/root/.local/share/Terraria/Worlds\n    environment:\n'
  + '      - worldpath=${WORLDPATH:-/root/.local/share/Terraria/Worlds}\n      - autocreate=${AUTOCREATE:-2}\n      - world=${WORLD:-world1.wld}\n      - difficulty=${DIFFICULTY:-1}\n      - maxplayers=${MAXPLAYERS:-8}\n      - password=${SERVICE_PASSWORD_TERRARIA}\n      - motd=${MOTD:-Welcome to the server!}\n      - language=${LANGUAGE:-en/US}\n      - secure=${SECURE:-1}\n';
export const terrariaIndex = { 'terraria-server': { name: 'Terraria Server', slogan: 'Docker multi-arch Image for Terraria Server.',
  category: 'games', documentation: 'https://github.com/hexlo/terraria-server-docker' } };
