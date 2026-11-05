export type StoreSoftwareTranslation = Readonly<{
  machineLabel: string;
  chooseMachine: string;
  approvalNote: string;
}>;

const en: StoreSoftwareTranslation = {
  machineLabel: 'Machine',
  approvalNote: 'Machine setup asks first. You approve it before it runs.',
  chooseMachine: 'Choose a Machine',
};

const ca: StoreSoftwareTranslation = {
  machineLabel: 'Màquina',
  approvalNote: 'La configuració de la Màquina demana permís primer. L’aproves abans que s’executi.',
  chooseMachine: 'Tria una Màquina',
};

const de: StoreSoftwareTranslation = {
  machineLabel: 'Maschine',
  approvalNote: 'Die Maschineneinrichtung fragt zuerst nach. Du gibst sie frei, bevor sie ausgeführt wird.',
  chooseMachine: 'Maschine wählen',
};

const es: StoreSoftwareTranslation = {
  machineLabel: 'Máquina',
  approvalNote: 'La configuración de la Máquina pide permiso primero. La apruebas antes de que se ejecute.',
  chooseMachine: 'Elige una Máquina',
};

const fr: StoreSoftwareTranslation = {
  machineLabel: 'Machine',
  approvalNote: 'La configuration de la Machine demande d’abord votre accord. Vous l’approuvez avant son exécution.',
  chooseMachine: 'Choisir une Machine',
};

const it: StoreSoftwareTranslation = {
  machineLabel: 'Macchina',
  approvalNote: 'La configurazione della Macchina chiede prima il permesso. La approvi prima che venga eseguita.',
  chooseMachine: 'Scegli una Macchina',
};

const ja: StoreSoftwareTranslation = {
  machineLabel: 'マシン',
  approvalNote: 'マシンのセットアップには事前の承認が必要です。承認するまで実行されません。',
  chooseMachine: 'マシンを選択',
};

const pl: StoreSoftwareTranslation = {
  machineLabel: 'Maszyna',
  approvalNote: 'Konfiguracja Maszyny najpierw pyta o zgodę. Zatwierdzasz ją przed uruchomieniem.',
  chooseMachine: 'Wybierz Maszynę',
};

const pt: StoreSoftwareTranslation = {
  machineLabel: 'Máquina',
  approvalNote: 'A configuração da Máquina pede permissão primeiro. Você a aprova antes da execução.',
  chooseMachine: 'Escolha uma Máquina',
};

const ru: StoreSoftwareTranslation = {
  machineLabel: 'Машина',
  approvalNote: 'Настройка Машины сначала запрашивает разрешение. Вы одобряете её до выполнения.',
  chooseMachine: 'Выберите машину',
};

const zhHans: StoreSoftwareTranslation = {
  machineLabel: '机器',
  approvalNote: '机器设置会先请求批准。经你批准后才会运行。',
  chooseMachine: '选择机器',
};

const zhHant: StoreSoftwareTranslation = {
  machineLabel: '機器',
  approvalNote: '機器設定會先請求核准。經你核准後才會執行。',
  chooseMachine: '選擇機器',
};

export const storeSoftwareTranslations = {
  en,
  ca,
  de,
  es,
  fr,
  it,
  ja,
  pl,
  pt,
  ru,
  zhHans,
  zhHant,
} as const;
