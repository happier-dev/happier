import type { SupportedLanguage } from '../_all';

/** Pets that travel with templates and shared Bots (PET-SHARE): the Copy row, its outcome, and a viewer's "Add <pet>". */
type Words = Readonly<{
  copyRow: string;
  copyRowOn: string;
  copyRowOff: string;
  copyRowUnavailable: string;
  copyCouldNotAdd: string;
  copyLibraryFull: string;
  copySyncOff: string;
  offerLine: string;
  offerAdd: string;
  offerCouldNotAdd: string;
  offerLibraryFull: string;
  offerSyncOff: string;
  offerUnreachable: string;
  chooserRegistryNote: string;
}>;

const words = {
  en: {
    copyRow: 'Pet: {name}',
    copyRowOn: 'Joins your pets, and your copy wears it.',
    copyRowOff: 'Your copy wears its own face.',
    copyRowUnavailable: "Pets aren't on for this Home, so your copy wears its own face.",
    copyCouldNotAdd:
      "Couldn't add {name} to your pets, so {bot} wears its own face.",
    copyLibraryFull: 'Your pets are full, so {bot} wears its own face.',
    copySyncOff: 'Pet sync is off, so {bot} wears its own face.',
    offerLine: "Its face is a pet you don't have yet.",
    offerAdd: 'Add {name}',
    offerCouldNotAdd: "Couldn't add {name}.",
    offerLibraryFull: 'Your pets are full. Remove one in Settings › Pets.',
    offerSyncOff: 'Adding pets needs pet sync.',
    offerUnreachable: "Couldn't reach {name}'s catalog.",
    chooserRegistryNote:
      'People you share this Bot with see {name} once they add it.',
  },
  fr: {
    copyRow: 'Compagnon : {name}',
    copyRowOn: 'Rejoint vos compagnons, et votre copie le porte.',
    copyRowOff: 'Votre copie garde son propre visage.',
    copyRowUnavailable: 'Les compagnons ne sont pas activés sur ce Home : votre copie garde son propre visage.',
    copyCouldNotAdd:
      'Impossible d’ajouter {name} à vos compagnons : {bot} garde son propre visage.',
    copyLibraryFull:
      'Vos compagnons sont au complet : {bot} garde son propre visage.',
    copySyncOff:
      'La synchronisation des compagnons est désactivée : {bot} garde son propre visage.',
    offerLine: 'Son visage est un compagnon que vous n’avez pas encore.',
    offerAdd: 'Ajouter {name}',
    offerCouldNotAdd: 'Impossible d’ajouter {name}.',
    offerLibraryFull:
      'Vos compagnons sont au complet. Retirez-en un dans Réglages › Animaux de compagnie.',
    offerSyncOff: 'Ajouter des compagnons nécessite leur synchronisation.',
    offerUnreachable: 'Impossible de joindre le catalogue de {name}.',
    chooserRegistryNote:
      'Les personnes avec qui vous partagez ce Bot voient {name} une fois qu’elles l’ont ajouté.',
  },
  de: {
    copyRow: 'Haustier: {name}',
    copyRowOn: 'Kommt zu deinen Haustieren, und deine Kopie trägt es.',
    copyRowOff: 'Deine Kopie behält ihr eigenes Gesicht.',
    copyRowUnavailable: 'Haustiere sind auf diesem Home nicht aktiv, daher behält deine Kopie ihr eigenes Gesicht.',
    copyCouldNotAdd:
      '{name} konnte nicht zu deinen Haustieren hinzugefügt werden, daher behält {bot} sein eigenes Gesicht.',
    copyLibraryFull:
      'Deine Haustiere sind voll, daher behält {bot} sein eigenes Gesicht.',
    copySyncOff:
      'Haustier-Sync ist aus, daher behält {bot} sein eigenes Gesicht.',
    offerLine: 'Sein Gesicht ist ein Haustier, das du noch nicht hast.',
    offerAdd: '{name} hinzufügen',
    offerCouldNotAdd: '{name} konnte nicht hinzugefügt werden.',
    offerLibraryFull:
      'Deine Haustiere sind voll. Entferne eines unter Einstellungen › Haustiere.',
    offerSyncOff: 'Zum Hinzufügen von Haustieren braucht es Haustier-Sync.',
    offerUnreachable: 'Der Katalog von {name} war nicht erreichbar.',
    chooserRegistryNote:
      'Wer diesen Bot mit dir teilt, sieht {name}, sobald er es hinzufügt.',
  },
  es: {
    copyRow: 'Mascota: {name}',
    copyRowOn: 'Se une a tus mascotas y tu copia la lleva.',
    copyRowOff: 'Tu copia mantiene su propia cara.',
    copyRowUnavailable: 'Las mascotas no están activadas en este Home, así que tu copia mantiene su propia cara.',
    copyCouldNotAdd:
      'No se pudo añadir a {name} a tus mascotas, así que {bot} mantiene su propia cara.',
    copyLibraryFull:
      'Tus mascotas están completas, así que {bot} mantiene su propia cara.',
    copySyncOff:
      'La sincronización de mascotas está desactivada, así que {bot} mantiene su propia cara.',
    offerLine: 'Su cara es una mascota que aún no tienes.',
    offerAdd: 'Añadir a {name}',
    offerCouldNotAdd: 'No se pudo añadir a {name}.',
    offerLibraryFull:
      'Tus mascotas están completas. Quita una en Ajustes › Mascotas.',
    offerSyncOff: 'Para añadir mascotas hace falta su sincronización.',
    offerUnreachable: 'No se pudo acceder al catálogo de {name}.',
    chooserRegistryNote:
      'Quienes comparten este Bot contigo ven a {name} cuando la añaden.',
  },
  it: {
    copyRow: 'Mascotte: {name}',
    copyRowOn: 'Si aggiunge alle tue mascotte e la tua copia la indossa.',
    copyRowOff: 'La tua copia mantiene il suo volto.',
    copyRowUnavailable: 'Le mascotte non sono attive su questo Home, quindi la tua copia mantiene il suo volto.',
    copyCouldNotAdd:
      'Impossibile aggiungere {name} alle tue mascotte, quindi {bot} mantiene il suo volto.',
    copyLibraryFull:
      'Le tue mascotte sono al completo, quindi {bot} mantiene il suo volto.',
    copySyncOff:
      'La sincronizzazione delle mascotte è disattivata, quindi {bot} mantiene il suo volto.',
    offerLine: 'Il suo volto è una mascotte che non hai ancora.',
    offerAdd: 'Aggiungi {name}',
    offerCouldNotAdd: 'Impossibile aggiungere {name}.',
    offerLibraryFull:
      'Le tue mascotte sono al completo. Rimuovine una in Impostazioni › Mascotte.',
    offerSyncOff: 'Per aggiungere mascotte serve la loro sincronizzazione.',
    offerUnreachable: 'Impossibile raggiungere il catalogo di {name}.',
    chooserRegistryNote:
      'Chi condivide questo Bot con te vede {name} dopo averla aggiunta.',
  },
  pt: {
    copyRow: 'Mascote: {name}',
    copyRowOn: 'Entra nos seus mascotes e a sua cópia usa-o.',
    copyRowOff: 'A sua cópia mantém o próprio rosto.',
    copyRowUnavailable: 'Os mascotes não estão ativos neste Home, por isso a sua cópia mantém o próprio rosto.',
    copyCouldNotAdd:
      'Não foi possível adicionar {name} aos seus mascotes, por isso {bot} mantém o próprio rosto.',
    copyLibraryFull:
      'Os seus mascotes estão cheios, por isso {bot} mantém o próprio rosto.',
    copySyncOff:
      'A sincronização de mascotes está desligada, por isso {bot} mantém o próprio rosto.',
    offerLine: 'O rosto dele é um mascote que você ainda não tem.',
    offerAdd: 'Adicionar {name}',
    offerCouldNotAdd: 'Não foi possível adicionar {name}.',
    offerLibraryFull:
      'Os seus mascotes estão cheios. Remova um em Configurações › Mascotes.',
    offerSyncOff: 'Adicionar mascotes requer a sincronização de mascotes.',
    offerUnreachable: 'Não foi possível aceder ao catálogo de {name}.',
    chooserRegistryNote:
      'Quem compartilha este Bot com você vê {name} depois de o adicionar.',
  },
  ca: {
    copyRow: 'Mascota: {name}',
    copyRowOn: 'S’afegeix a les teves mascotes i la teva còpia la porta.',
    copyRowOff: 'La teva còpia conserva la seva pròpia cara.',
    copyRowUnavailable: 'Les mascotes no estan activades en aquest Home, així que la teva còpia conserva la seva pròpia cara.',
    copyCouldNotAdd:
      'No s’ha pogut afegir {name} a les teves mascotes, així que {bot} conserva la seva pròpia cara.',
    copyLibraryFull:
      'Les teves mascotes són plenes, així que {bot} conserva la seva pròpia cara.',
    copySyncOff:
      'La sincronització de mascotes està desactivada, així que {bot} conserva la seva pròpia cara.',
    offerLine: 'La seva cara és una mascota que encara no tens.',
    offerAdd: 'Afegeix {name}',
    offerCouldNotAdd: 'No s’ha pogut afegir {name}.',
    offerLibraryFull:
      'Les teves mascotes són plenes. Treu-ne una a Configuració › Mascotes.',
    offerSyncOff: 'Per afegir mascotes cal la seva sincronització.',
    offerUnreachable: 'No s’ha pogut accedir al catàleg de {name}.',
    chooserRegistryNote:
      'Les persones amb qui comparteixes aquest Bot veuen {name} quan l’afegeixen.',
  },
  ja: {
    copyRow: 'ペット：{name}',
    copyRowOn: 'あなたのペットに加わり、コピーがこの顔になります。',
    copyRowOff: 'コピーは自分の顔のままです。',
    copyRowUnavailable: 'この Home ではペットがオンになっていないため、コピーは自分の顔のままです。',
    copyCouldNotAdd:
      '{name} をペットに追加できなかったため、{bot} は自分の顔のままです。',
    copyLibraryFull: 'ペットがいっぱいのため、{bot} は自分の顔のままです。',
    copySyncOff: 'ペットの同期がオフのため、{bot} は自分の顔のままです。',
    offerLine: 'この顔は、まだ持っていないペットです。',
    offerAdd: '{name} を追加',
    offerCouldNotAdd: '{name} を追加できませんでした。',
    offerLibraryFull:
      'ペットがいっぱいです。設定 › ペット で1つ削除してください。',
    offerSyncOff: 'ペットを追加するにはペットの同期が必要です。',
    offerUnreachable: '{name} のカタログに接続できませんでした。',
    chooserRegistryNote:
      'この Bot を共有した相手は、{name} を追加すると見られるようになります。',
  },
  ru: {
    copyRow: 'Питомец: {name}',
    copyRowOn: 'Появится среди ваших питомцев, и копия будет с ним.',
    copyRowOff: 'Копия сохранит своё лицо.',
    copyRowUnavailable: 'Питомцы на этом Home выключены, поэтому копия сохранит своё лицо.',
    copyCouldNotAdd:
      'Не удалось добавить {name} к вашим питомцам, поэтому у {bot} своё лицо.',
    copyLibraryFull: 'Питомцев уже максимум, поэтому у {bot} своё лицо.',
    copySyncOff: 'Синхронизация питомцев выключена, поэтому у {bot} своё лицо.',
    offerLine: 'Его лицо — питомец, которого у вас ещё нет.',
    offerAdd: 'Добавить {name}',
    offerCouldNotAdd: 'Не удалось добавить {name}.',
    offerLibraryFull:
      'Питомцев уже максимум. Удалите одного в Настройки › Питомцы.',
    offerSyncOff: 'Чтобы добавлять питомцев, нужна их синхронизация.',
    offerUnreachable: 'Не удалось связаться с каталогом {name}.',
    chooserRegistryNote:
      'Те, с кем вы делитесь этим ботом, увидят {name}, когда добавят его.',
  },
  pl: {
    copyRow: 'Zwierzak: {name}',
    copyRowOn: 'Dołącza do twoich zwierzaków, a twoja kopia go nosi.',
    copyRowOff: 'Twoja kopia zachowuje własną twarz.',
    copyRowUnavailable: 'Zwierzaki są wyłączone w tym Home, więc twoja kopia zachowuje własną twarz.',
    copyCouldNotAdd:
      'Nie udało się dodać {name} do twoich zwierzaków, więc {bot} zachowuje własną twarz.',
    copyLibraryFull:
      'Masz już komplet zwierzaków, więc {bot} zachowuje własną twarz.',
    copySyncOff:
      'Synchronizacja zwierzaków jest wyłączona, więc {bot} zachowuje własną twarz.',
    offerLine: 'Jego twarz to zwierzak, którego jeszcze nie masz.',
    offerAdd: 'Dodaj {name}',
    offerCouldNotAdd: 'Nie udało się dodać {name}.',
    offerLibraryFull:
      'Masz już komplet zwierzaków. Usuń jednego w Ustawienia › Zwierzaki.',
    offerSyncOff: 'Dodawanie zwierzaków wymaga ich synchronizacji.',
    offerUnreachable: 'Nie udało się połączyć z katalogiem {name}.',
    chooserRegistryNote:
      'Osoby, którym udostępniasz tego Bota, zobaczą {name}, gdy go dodadzą.',
  },
  'zh-Hans': {
    copyRow: '宠物：{name}',
    copyRowOn: '加入你的宠物，你的副本会用它作面孔。',
    copyRowOff: '你的副本保留它自己的面孔。',
    copyRowUnavailable: '此 Home 未开启宠物，所以你的副本保留它自己的面孔。',
    copyCouldNotAdd:
      '无法将 {name} 添加到你的宠物，所以 {bot} 保留自己的面孔。',
    copyLibraryFull: '你的宠物已满，所以 {bot} 保留自己的面孔。',
    copySyncOff: '宠物同步已关闭，所以 {bot} 保留自己的面孔。',
    offerLine: '它的面孔是一只你还没有的宠物。',
    offerAdd: '添加 {name}',
    offerCouldNotAdd: '无法添加 {name}。',
    offerLibraryFull: '你的宠物已满。请在 设置 › 宠物 中移除一只。',
    offerSyncOff: '添加宠物需要开启宠物同步。',
    offerUnreachable: '无法连接 {name} 的目录。',
    chooserRegistryNote: '与你共享此 Bot 的人添加 {name} 后就能看到它。',
  },
  'zh-Hant': {
    copyRow: '寵物：{name}',
    copyRowOn: '加入你的寵物，你的副本會用它作臉孔。',
    copyRowOff: '你的副本保留它自己的臉孔。',
    copyRowUnavailable: '此 Home 未開啟寵物，所以你的副本保留它自己的臉孔。',
    copyCouldNotAdd:
      '無法將 {name} 新增到你的寵物，所以 {bot} 保留自己的臉孔。',
    copyLibraryFull: '你的寵物已滿，所以 {bot} 保留自己的臉孔。',
    copySyncOff: '寵物同步已關閉，所以 {bot} 保留自己的臉孔。',
    offerLine: '它的臉孔是一隻你還沒有的寵物。',
    offerAdd: '新增 {name}',
    offerCouldNotAdd: '無法新增 {name}。',
    offerLibraryFull: '你的寵物已滿。請在 設定 › 寵物 中移除一隻。',
    offerSyncOff: '新增寵物需要開啟寵物同步。',
    offerUnreachable: '無法連線到 {name} 的目錄。',
    chooserRegistryNote: '與你共享此 Bot 的人新增 {name} 後就能看到它。',
  },
} as const satisfies Record<SupportedLanguage, Words>;

const fill = (text: string, values: Readonly<Record<string, string>>) =>
  text.replace(/\{(\w+)\}/g, (match, key: string) => values[key] ?? match);

function copy(language: SupportedLanguage) {
  const w: Words = words[language];
  return {
    copyRow: ({ name }: { name: string }) => fill(w.copyRow, { name }),
    copyRowOn: w.copyRowOn,
    copyRowOff: w.copyRowOff,
    copyRowUnavailable: w.copyRowUnavailable,
    copyCouldNotAdd: ({ name, bot }: { name: string; bot: string }) =>
      fill(w.copyCouldNotAdd, { name, bot }),
    copyLibraryFull: ({ bot }: { bot: string }) =>
      fill(w.copyLibraryFull, { bot }),
    copySyncOff: ({ bot }: { bot: string }) => fill(w.copySyncOff, { bot }),
    offerLine: w.offerLine,
    offerAdd: ({ name }: { name: string }) => fill(w.offerAdd, { name }),
    offerCouldNotAdd: ({ name }: { name: string }) =>
      fill(w.offerCouldNotAdd, { name }),
    offerLibraryFull: w.offerLibraryFull,
    offerSyncOff: w.offerSyncOff,
    offerUnreachable: ({ name }: { name: string }) =>
      fill(w.offerUnreachable, { name }),
    chooserRegistryNote: ({ name }: { name: string }) =>
      fill(w.chooserRegistryNote, { name }),
  };
}

export const petShareTranslations = {
  en: copy('en'),
  fr: copy('fr'),
  de: copy('de'),
  es: copy('es'),
  it: copy('it'),
  pt: copy('pt'),
  ca: copy('ca'),
  ja: copy('ja'),
  ru: copy('ru'),
  pl: copy('pl'),
  'zh-Hans': copy('zh-Hans'),
  'zh-Hant': copy('zh-Hant'),
} satisfies Record<SupportedLanguage, ReturnType<typeof copy>>;
