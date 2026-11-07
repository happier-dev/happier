import type { BotFaceBody, BotFacePalette } from '@happier-dev/protocol/sessions/identity/sessionBotV1';

// The names the face picker shows for each body and colour, keyed by the protocol catalogs, so a new body or
// colour fails the typecheck in every locale until it is named.
export type BotFaceNames = Readonly<{
  accountDefault: string;
  bodies: Readonly<Record<BotFaceBody, string>>;
  colours: Readonly<Record<BotFacePalette, string>>;
}>;

export const botFaceNameTranslations = {
  en: {
    accountDefault: 'Account default',
    bodies: { crab: "Crab", squid: "Squid", octopus: "Octopus", ufo: "Saucer", specter: "Specter", ghost: "Ghost", beetle: "Beetle", spider: "Spider", jelly: "Jelly", hopper: "Hopper", pup: "Pup", drone: "Drone", robot: "Robot", walker: "Walker", rocket: "Rocket", feet: "Feet", tail: "Tail", drip: "Drip", bracelegs: "Brace legs", tagclaws: "Tag claws", cursortail: "Cursor tail", termbody: "Terminal", antlers: "Branch antlers", semi: "Semicolon", brackets: "Brackets", cursor: "Cursor", bean: "Bean", squat: "Squat", bag: "Bag", loaf: "Loaf", puddle: "Puddle", tower: "Tower", stilts: "Stilts", tall: "Tall", cat: "Cat" },
    colours: { daybreak: "Daybreak", lagoon: "Lagoon", orchid: "Orchid", aurora: "Aurora", indigo: "Indigo", glacier: "Glacier", moss: "Moss", sand: "Sand", ink: "Ink" },
  },
  es: {
    accountDefault: 'Predeterminado de la cuenta',
    bodies: { crab: "Cangrejo", squid: "Calamar", octopus: "Pulpo", ufo: "Platillo", specter: "Espectro", ghost: "Fantasma", beetle: "Escarabajo", spider: "Araña", jelly: "Medusa", hopper: "Saltarín", pup: "Cachorro", drone: "Dron", robot: "Robot", walker: "Caminante", rocket: "Cohete", feet: "Pies", tail: "Cola", drip: "Gota", bracelegs: "Patas de llaves", tagclaws: "Pinzas de etiqueta", cursortail: "Cola de cursor", termbody: "Terminal", antlers: "Astas de rama", semi: "Punto y coma", brackets: "Corchetes", cursor: "Cursor", bean: "Alubia", squat: "Rechoncho", bag: "Bolsa", loaf: "Hogaza", puddle: "Charco", tower: "Torre", stilts: "Zancos", tall: "Alto", cat: "Gato" },
    colours: { daybreak: "Amanecer", lagoon: "Laguna", orchid: "Orquídea", aurora: "Aurora", indigo: "Índigo", glacier: "Glaciar", moss: "Musgo", sand: "Arena", ink: "Tinta" },
  },
  de: {
    accountDefault: 'Kontostandard',
    bodies: { crab: "Krabbe", squid: "Kalmar", octopus: "Oktopus", ufo: "Untertasse", specter: "Phantom", ghost: "Geist", beetle: "Käfer", spider: "Spinne", jelly: "Qualle", hopper: "Hüpfer", pup: "Welpe", drone: "Drohne", robot: "Roboter", walker: "Läufer", rocket: "Rakete", feet: "Füße", tail: "Schwanz", drip: "Tropfen", bracelegs: "Klammerbeine", tagclaws: "Tag-Scheren", cursortail: "Cursorschwanz", termbody: "Terminal", antlers: "Zweiggeweih", semi: "Semikolon", brackets: "Klammern", cursor: "Cursor", bean: "Bohne", squat: "Gedrungen", bag: "Beutel", loaf: "Laib", puddle: "Pfütze", tower: "Turm", stilts: "Stelzen", tall: "Lang", cat: "Katze" },
    colours: { daybreak: "Morgenrot", lagoon: "Lagune", orchid: "Orchidee", aurora: "Polarlicht", indigo: "Indigo", glacier: "Gletscher", moss: "Moos", sand: "Sand", ink: "Tinte" },
  },
  fr: {
    accountDefault: 'Défaut du compte',
    bodies: { crab: "Crabe", squid: "Calmar", octopus: "Pieuvre", ufo: "Soucoupe", specter: "Spectre", ghost: "Fantôme", beetle: "Scarabée", spider: "Araignée", jelly: "Méduse", hopper: "Sauteur", pup: "Chiot", drone: "Drone", robot: "Robot", walker: "Marcheur", rocket: "Fusée", feet: "Pieds", tail: "Queue", drip: "Goutte", bracelegs: "Pattes accolades", tagclaws: "Pinces balises", cursortail: "Queue curseur", termbody: "Terminal", antlers: "Bois de branche", semi: "Point-virgule", brackets: "Crochets", cursor: "Curseur", bean: "Haricot", squat: "Trapu", bag: "Sac", loaf: "Miche", puddle: "Flaque", tower: "Tour", stilts: "Échasses", tall: "Grand", cat: "Chat" },
    colours: { daybreak: "Aube", lagoon: "Lagon", orchid: "Orchidée", aurora: "Aurore", indigo: "Indigo", glacier: "Glacier", moss: "Mousse", sand: "Sable", ink: "Encre" },
  },
  it: {
    accountDefault: 'Predefinito dell’account',
    bodies: { crab: "Granchio", squid: "Calamaro", octopus: "Polpo", ufo: "Disco volante", specter: "Spettro", ghost: "Fantasma", beetle: "Scarabeo", spider: "Ragno", jelly: "Medusa", hopper: "Saltatore", pup: "Cucciolo", drone: "Drone", robot: "Robot", walker: "Camminatore", rocket: "Razzo", feet: "Piedi", tail: "Coda", drip: "Goccia", bracelegs: "Zampe a graffa", tagclaws: "Chele a tag", cursortail: "Coda a cursore", termbody: "Terminale", antlers: "Corna a ramo", semi: "Punto e virgola", brackets: "Parentesi", cursor: "Cursore", bean: "Fagiolo", squat: "Tozzo", bag: "Sacco", loaf: "Pagnotta", puddle: "Pozzanghera", tower: "Torre", stilts: "Trampoli", tall: "Alto", cat: "Gatto" },
    colours: { daybreak: "Alba", lagoon: "Laguna", orchid: "Orchidea", aurora: "Aurora", indigo: "Indaco", glacier: "Ghiacciaio", moss: "Muschio", sand: "Sabbia", ink: "Inchiostro" },
  },
  pt: {
    accountDefault: 'Padrão da conta',
    bodies: { crab: "Caranguejo", squid: "Lula", octopus: "Polvo", ufo: "Disco voador", specter: "Espectro", ghost: "Fantasma", beetle: "Besouro", spider: "Aranha", jelly: "Água-viva", hopper: "Saltador", pup: "Filhote", drone: "Drone", robot: "Robô", walker: "Andarilho", rocket: "Foguete", feet: "Pés", tail: "Cauda", drip: "Gota", bracelegs: "Pernas de chaves", tagclaws: "Pinças de tag", cursortail: "Cauda de cursor", termbody: "Terminal", antlers: "Chifres de ramo", semi: "Ponto e vírgula", brackets: "Colchetes", cursor: "Cursor", bean: "Feijão", squat: "Atarracado", bag: "Saco", loaf: "Pão", puddle: "Poça", tower: "Torre", stilts: "Pernas de pau", tall: "Alto", cat: "Gato" },
    colours: { daybreak: "Alvorada", lagoon: "Lagoa", orchid: "Orquídea", aurora: "Aurora", indigo: "Índigo", glacier: "Geleira", moss: "Musgo", sand: "Areia", ink: "Tinta" },
  },
  ru: {
    accountDefault: 'По умолчанию для аккаунта',
    bodies: { crab: "Краб", squid: "Кальмар", octopus: "Осьминог", ufo: "Тарелка", specter: "Призрак", ghost: "Привидение", beetle: "Жук", spider: "Паук", jelly: "Медуза", hopper: "Попрыгун", pup: "Щенок", drone: "Дрон", robot: "Робот", walker: "Ходок", rocket: "Ракета", feet: "Ножки", tail: "Хвост", drip: "Капля", bracelegs: "Ноги-скобки", tagclaws: "Клешни-теги", cursortail: "Хвост-курсор", termbody: "Терминал", antlers: "Рога-ветки", semi: "Точка с запятой", brackets: "Скобки", cursor: "Курсор", bean: "Боб", squat: "Коротышка", bag: "Мешок", loaf: "Буханка", puddle: "Лужа", tower: "Башня", stilts: "Ходули", tall: "Высокий", cat: "Кошка" },
    colours: { daybreak: "Рассвет", lagoon: "Лагуна", orchid: "Орхидея", aurora: "Сияние", indigo: "Индиго", glacier: "Ледник", moss: "Мох", sand: "Песок", ink: "Чернила" },
  },
  ja: {
    accountDefault: 'アカウントのデフォルト',
    bodies: { crab: "カニ", squid: "イカ", octopus: "タコ", ufo: "円盤", specter: "亡霊", ghost: "おばけ", beetle: "カブトムシ", spider: "クモ", jelly: "クラゲ", hopper: "ホッパー", pup: "子犬", drone: "ドローン", robot: "ロボット", walker: "ウォーカー", rocket: "ロケット", feet: "あし", tail: "しっぽ", drip: "しずく", bracelegs: "波かっこの脚", tagclaws: "タグのハサミ", cursortail: "カーソルしっぽ", termbody: "ターミナル", antlers: "ブランチの角", semi: "セミコロン", brackets: "かっこ", cursor: "カーソル", bean: "豆", squat: "ずんぐり", bag: "ふくろ", loaf: "食パン", puddle: "水たまり", tower: "タワー", stilts: "竹馬", tall: "のっぽ", cat: "ネコ" },
    colours: { daybreak: "夜明け", lagoon: "ラグーン", orchid: "オーキッド", aurora: "オーロラ", indigo: "インディゴ", glacier: "氷河", moss: "モス", sand: "サンド", ink: "インク" },
  },
  'zh-Hans': {
    accountDefault: '账户默认值',
    bodies: { crab: "螃蟹", squid: "鱿鱼", octopus: "章鱼", ufo: "飞碟", specter: "魅影", ghost: "幽灵", beetle: "甲虫", spider: "蜘蛛", jelly: "水母", hopper: "跳跳", pup: "小狗", drone: "无人机", robot: "机器人", walker: "行者", rocket: "火箭", feet: "小脚", tail: "尾巴", drip: "水滴", bracelegs: "花括号腿", tagclaws: "标签钳", cursortail: "光标尾巴", termbody: "终端", antlers: "分支鹿角", semi: "分号", brackets: "括号", cursor: "光标", bean: "豆子", squat: "矮墩", bag: "袋子", loaf: "面包", puddle: "水洼", tower: "高塔", stilts: "高跷", tall: "高个", cat: "猫" },
    colours: { daybreak: "破晓", lagoon: "泻湖", orchid: "兰花", aurora: "极光", indigo: "靛蓝", glacier: "冰川", moss: "苔藓", sand: "沙色", ink: "墨色" },
  },
  'zh-Hant': {
    accountDefault: '帳戶預設值',
    bodies: { crab: "螃蟹", squid: "魷魚", octopus: "章魚", ufo: "飛碟", specter: "魅影", ghost: "幽靈", beetle: "甲蟲", spider: "蜘蛛", jelly: "水母", hopper: "跳跳", pup: "小狗", drone: "無人機", robot: "機器人", walker: "行者", rocket: "火箭", feet: "小腳", tail: "尾巴", drip: "水滴", bracelegs: "大括號腿", tagclaws: "標籤鉗", cursortail: "游標尾巴", termbody: "終端機", antlers: "分支鹿角", semi: "分號", brackets: "括號", cursor: "游標", bean: "豆子", squat: "矮墩", bag: "袋子", loaf: "麵包", puddle: "水窪", tower: "高塔", stilts: "高蹺", tall: "高個", cat: "貓" },
    colours: { daybreak: "破曉", lagoon: "潟湖", orchid: "蘭花", aurora: "極光", indigo: "靛藍", glacier: "冰河", moss: "苔蘚", sand: "沙色", ink: "墨色" },
  },
  pl: {
    accountDefault: 'Domyślne ustawienie konta',
    bodies: { crab: "Krab", squid: "Kałamarnica", octopus: "Ośmiornica", ufo: "Spodek", specter: "Widmo", ghost: "Duch", beetle: "Żuk", spider: "Pająk", jelly: "Meduza", hopper: "Skoczek", pup: "Szczeniak", drone: "Dron", robot: "Robot", walker: "Piechur", rocket: "Rakieta", feet: "Stopy", tail: "Ogon", drip: "Kropla", bracelegs: "Nogi z klamer", tagclaws: "Szczypce znaczników", cursortail: "Ogon kursora", termbody: "Terminal", antlers: "Poroże z gałęzi", semi: "Średnik", brackets: "Nawiasy", cursor: "Kursor", bean: "Fasolka", squat: "Przysadzisty", bag: "Worek", loaf: "Bochenek", puddle: "Kałuża", tower: "Wieża", stilts: "Szczudła", tall: "Wysoki", cat: "Kot" },
    colours: { daybreak: "Świt", lagoon: "Laguna", orchid: "Storczyk", aurora: "Zorza", indigo: "Indygo", glacier: "Lodowiec", moss: "Mech", sand: "Piasek", ink: "Atrament" },
  },
  ca: {
    accountDefault: 'Predeterminat del compte',
    bodies: { crab: "Cranc", squid: "Calamar", octopus: "Pop", ufo: "Plat volador", specter: "Espectre", ghost: "Fantasma", beetle: "Escarabat", spider: "Aranya", jelly: "Medusa", hopper: "Saltador", pup: "Cadell", drone: "Dron", robot: "Robot", walker: "Caminant", rocket: "Coet", feet: "Peus", tail: "Cua", drip: "Gota", bracelegs: "Potes de claus", tagclaws: "Pinces d'etiqueta", cursortail: "Cua de cursor", termbody: "Terminal", antlers: "Banyes de branca", semi: "Punt i coma", brackets: "Claudàtors", cursor: "Cursor", bean: "Mongeta", squat: "Rabassut", bag: "Bossa", loaf: "Pa", puddle: "Bassal", tower: "Torre", stilts: "Xanques", tall: "Alt", cat: "Gat" },
    colours: { daybreak: "Alba", lagoon: "Llacuna", orchid: "Orquídia", aurora: "Aurora", indigo: "Indi", glacier: "Glacera", moss: "Molsa", sand: "Sorra", ink: "Tinta" },
  },
} as const satisfies Readonly<Record<string, BotFaceNames>>;
